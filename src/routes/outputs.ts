import type { FastifyPluginAsync } from 'fastify';
import { randomUUID } from 'crypto';
import { z } from 'zod';
import { getOutputsDb, getDb } from '../db/index.js';
import type { OutputDoc, ProductionDoc } from '../db/types.js';
import { updateProductionDoc } from './productions.js';
import { mxlDomain, mxlFlowId, srtUrl } from '../lib/url-validation.js';

const SRT_OUTPUT_TYPES = new Set(['mpegtssrt', 'efpsrt']);

const MxlTap = z.enum(['pgm', 'multiview']);
const MxlBackend = z.enum(['auto', 'gpu', 'cpu']);
const MxlAudioSource = z.enum(['main', 'monitor']);

const OutputInput = z.object({
  name: z.string().min(1),
  outputType: z.enum(['mpegtssrt', 'efpsrt', 'whep', 'mxl']),
  url: z.string().optional(),
  mxlTap: MxlTap.optional(),
  mxlDomain: z.string().optional(),
  mxlAudioFlowId: z.string().optional(),
  mxlAudioSource: MxlAudioSource.optional(),
  mxlBackend: MxlBackend.optional(),
  mxlLabel: z.string().optional(),
  mxlGroupHint: z.string().optional(),
}).superRefine((data, ctx) => {
  if (SRT_OUTPUT_TYPES.has(data.outputType) && data.url) {
    try {
      srtUrl(data.url);
    } catch (err) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['url'], message: err instanceof Error ? err.message : 'Invalid SRT URL' });
    }
  }
  if (data.outputType === 'mxl') {
    if (data.url) {
      try { mxlFlowId(data.url); } catch (err) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['url'], message: err instanceof Error ? err.message : 'Invalid MXL flow ID' });
      }
    }
    if (data.mxlDomain) {
      try { mxlDomain(data.mxlDomain); } catch (err) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['mxlDomain'], message: err instanceof Error ? err.message : 'Invalid MXL domain' });
      }
    }
    if (data.mxlAudioFlowId) {
      try { mxlFlowId(data.mxlAudioFlowId); } catch (err) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['mxlAudioFlowId'], message: err instanceof Error ? err.message : 'Invalid MXL audio flow ID' });
      }
    }
  }
});

const OutputPatch = z.object({
  name: z.string().min(1).optional(),
  url: z.string().optional(),
  mxlTap: MxlTap.optional(),
  mxlDomain: z.string().optional(),
  mxlAudioFlowId: z.string().optional(),
  mxlAudioSource: MxlAudioSource.optional(),
  mxlBackend: MxlBackend.optional(),
  mxlLabel: z.string().optional(),
  mxlGroupHint: z.string().optional(),
});

function toApi(doc: OutputDoc) {
  const { _id, _rev, type, ...rest } = doc;
  return { id: _id, ...rest };
}

const outputsRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/api/v1/outputs', async (_req, reply) => {
    const db = getOutputsDb();
    let result: Awaited<ReturnType<typeof db.find>>;
    try {
      result = await db.find({ selector: { type: 'output' } });
    } catch (err) {
      fastify.log.warn({ err }, 'GET /api/v1/outputs — DB query failed');
      return reply.status(503).send({ error: 'Database unavailable' });
    }
    return reply.send((Array.isArray(result?.docs) ? result.docs : []).map(toApi));
  });

  fastify.post('/api/v1/outputs', async (req, reply) => {
    const body = OutputInput.parse(req.body);
    const now = new Date().toISOString();
    const doc: OutputDoc = {
      _id: `output-${randomUUID()}`,
      type: 'output',
      name: body.name,
      outputType: body.outputType,
      url: body.url,
      mxlTap: body.mxlTap,
      mxlDomain: body.mxlDomain,
      mxlAudioFlowId: body.mxlAudioFlowId,
      mxlAudioSource: body.mxlAudioSource,
      mxlBackend: body.mxlBackend,
      mxlLabel: body.mxlLabel,
      mxlGroupHint: body.mxlGroupHint,
      createdAt: now,
      updatedAt: now,
    };
    await getOutputsDb().insert(doc);
    return reply.status(201).send(toApi(doc));
  });

  fastify.get<{ Params: { id: string } }>('/api/v1/outputs/:id', async (req, reply) => {
    try {
      const doc = await getOutputsDb().get(req.params.id);
      return reply.send(toApi(doc));
    } catch {
      return reply.status(404).send({ error: 'Output not found', statusCode: 404 });
    }
  });

  fastify.patch<{ Params: { id: string } }>('/api/v1/outputs/:id', async (req, reply) => {
    const body = OutputPatch.parse(req.body);
    try {
      const doc = await getOutputsDb().get(req.params.id);
      const effectiveUrl = body.url ?? doc.url;
      if (SRT_OUTPUT_TYPES.has(doc.outputType) && effectiveUrl) {
        try {
          srtUrl(effectiveUrl);
        } catch (err) {
          return reply.status(400).send({ error: err instanceof Error ? err.message : 'Invalid SRT URL' });
        }
      }
      if (doc.outputType === 'mxl') {
        try {
          if (effectiveUrl) mxlFlowId(effectiveUrl);
          if (body.mxlDomain) mxlDomain(body.mxlDomain);
          if (body.mxlAudioFlowId) mxlFlowId(body.mxlAudioFlowId);
        } catch (err) {
          return reply.status(400).send({ error: err instanceof Error ? err.message : 'Invalid MXL output field' });
        }
      }
      const updated: OutputDoc = { ...doc, ...body, updatedAt: new Date().toISOString() };
      await getOutputsDb().insert(updated);
      return reply.send(toApi(updated));
    } catch (err: unknown) {
      if (err && typeof err === 'object' && 'statusCode' in err && (err as { statusCode: number }).statusCode === 404) {
        return reply.status(404).send({ error: 'Output not found', statusCode: 404 });
      }
      throw err;
    }
  });

  fastify.delete<{ Params: { id: string } }>('/api/v1/outputs/:id', async (req, reply) => {
    try {
      const doc = await getOutputsDb().get(req.params.id);

      // Block deletion if output is used by an active/activating production
      const allProds = await getDb().find({
        selector: { type: 'production' },
        fields: ['_id', 'name', 'status', 'outputAssignments', 'deletionWarnings'],
        limit: 200,
      });
      const activeInUse = allProds.docs.some((p) => {
        const prod = p as unknown as ProductionDoc;
        return (prod.status === 'active' || prod.status === 'activating') &&
          prod.outputAssignments?.some((a) => a.outputId === req.params.id);
      });
      if (activeInUse) {
        return reply.status(409).send({ error: 'Output is used in an active production', statusCode: 409 });
      }

      // Remove references from inactive productions and record a warning
      for (const p of allProds.docs) {
        const prod = p as unknown as ProductionDoc;
        if (prod.status !== 'inactive') continue;
        if (!prod.outputAssignments?.some((a) => a.outputId === req.params.id)) continue;
        const warnings = prod.deletionWarnings ?? [];
        warnings.push({ type: 'output', name: doc.name });
        await updateProductionDoc(prod._id, {
          outputAssignments: (prod.outputAssignments ?? []).filter((a) => a.outputId !== req.params.id),
          deletionWarnings: warnings,
        });
      }

      await getOutputsDb().destroy(doc._id, doc._rev!);
      return reply.status(204).send();
    } catch (err: unknown) {
      if (err && typeof err === 'object' && 'statusCode' in err && (err as { statusCode: number }).statusCode === 404) {
        return reply.status(404).send({ error: 'Output not found' });
      }
      throw err;
    }
  });
};

export default outputsRoutes;
