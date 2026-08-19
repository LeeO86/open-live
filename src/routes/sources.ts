import type { FastifyPluginAsync } from 'fastify';
import { randomUUID } from 'crypto';
import { z } from 'zod';
import { getSourcesDb, getDb } from '../db/index.js';
import type { SourceDoc, ProductionDoc, StreamType } from '../db/types.js';
import { updateProductionDoc } from './productions.js';
import { decklinkDevice, graphicUrl, mxlDomain, mxlFlowId, srtUrl } from '../lib/url-validation.js';

const CREATABLE_STREAM_TYPES = ['srt', 'efp', 'whip', 'html', 'mxl', 'decklink'] as const;

const MxlBackend = z.enum(['auto', 'gpu', 'cpu']);

function validateSourceAddress(streamType: StreamType | (typeof CREATABLE_STREAM_TYPES)[number], address: string): void {
  if (streamType === 'html') {
    graphicUrl(address);
  } else if (streamType === 'srt' || streamType === 'efp') {
    srtUrl(address);
  } else if (streamType === 'mxl') {
    mxlFlowId(address);
  } else if (streamType === 'decklink') {
    decklinkDevice(address);
  }
}

const SourceInput = z.object({
  name: z.string().min(1),
  address: z.string(),
  streamType: z.enum(CREATABLE_STREAM_TYPES),
  status: z.enum(['active', 'inactive']).default('inactive'),
  liveCamera: z.boolean().optional(),
  latency: z.number().int().min(20).max(8000).optional(),
  mxlDomain: z.string().optional(),
  mxlAudioFlowId: z.string().optional(),
  mxlBackend: MxlBackend.optional(),
  decklinkMode: z.string().optional(),
  decklinkConnection: z.string().optional(),
  decklinkVideoFormat: z.string().optional(),
}).superRefine((data, ctx) => {
  try {
    validateSourceAddress(data.streamType, data.address);
  } catch (err) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['address'], message: err instanceof Error ? err.message : 'Invalid source address' });
  }
  if (data.streamType === 'mxl') {
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

const SourcePatch = z.object({
  name: z.string().min(1).optional(),
  address: z.string().optional(),
  streamType: z.enum(CREATABLE_STREAM_TYPES).optional(),
  status: z.enum(['active', 'inactive']).optional(),
  liveCamera: z.boolean().optional(),
  latency: z.number().int().min(20).max(8000).optional(),
  mxlDomain: z.string().optional(),
  mxlAudioFlowId: z.string().optional(),
  mxlBackend: MxlBackend.optional(),
  decklinkMode: z.string().optional(),
  decklinkConnection: z.string().optional(),
  decklinkVideoFormat: z.string().optional(),
});

/** Masks passphrase values in SRT URIs so credentials are never returned to clients. */
function maskSrtPassphrase(address: string): string {
  return address.replace(/([?&]passphrase=)[^&]*/gi, '$1***');
}

function toApi(doc: SourceDoc) {
  const { _id, _rev, type, ...rest } = doc;
  return { id: _id, ...rest, address: maskSrtPassphrase(rest.address) };
}

const sourcesRoutes: FastifyPluginAsync = async (fastify) => {
  // List all sources
  fastify.get('/api/v1/sources', async (_req, reply) => {
    const db = getSourcesDb();
    let result: Awaited<ReturnType<typeof db.find>>;
    try {
      result = await db.find({ selector: { type: 'source' } });
    } catch (err) {
      fastify.log.warn({ err }, 'GET /api/v1/sources — DB query failed');
      return reply.status(503).send({ error: 'Database unavailable' });
    }
    return reply.send((Array.isArray(result?.docs) ? result.docs : []).map(toApi));
  });

  // Create a source
  fastify.post('/api/v1/sources', async (req, reply) => {
    const body = SourceInput.parse(req.body);
    const now = new Date().toISOString();
    const doc: SourceDoc = {
      _id: `src-${randomUUID()}`,
      type: 'source',
      name: body.name,
      address: body.address,
      streamType: body.streamType,
      status: body.status,
      liveCamera: body.liveCamera,
      latency: body.latency,
      mxlDomain: body.mxlDomain,
      mxlAudioFlowId: body.mxlAudioFlowId,
      mxlBackend: body.mxlBackend,
      decklinkMode: body.decklinkMode,
      decklinkConnection: body.decklinkConnection,
      decklinkVideoFormat: body.decklinkVideoFormat,
      createdAt: now,
      updatedAt: now,
    };
    await getSourcesDb().insert(doc);
    return reply.status(201).send(toApi(doc));
  });

  // Get a source
  fastify.get<{ Params: { id: string } }>('/api/v1/sources/:id', async (req, reply) => {
    try {
      const doc = await getSourcesDb().get(req.params.id);
      return reply.send(toApi(doc));
    } catch {
      return reply.status(404).send({ error: 'Source not found', statusCode: 404 });
    }
  });

  // Update a source
  fastify.patch<{ Params: { id: string } }>('/api/v1/sources/:id', async (req, reply) => {
    const body = SourcePatch.parse(req.body);
    try {
      const doc = await getSourcesDb().get(req.params.id);
      // Determine effective streamType and address after the patch
      const effectiveStreamType = body.streamType ?? doc.streamType;
      const effectiveAddress = body.address ?? doc.address;
      if (effectiveAddress) {
        try {
          validateSourceAddress(effectiveStreamType, effectiveAddress);
        } catch (err) {
          return reply.status(400).send({ error: err instanceof Error ? err.message : 'Invalid source address' });
        }
      }
      if (effectiveStreamType === 'mxl') {
        try {
          if (body.mxlDomain) mxlDomain(body.mxlDomain);
          if (body.mxlAudioFlowId) mxlFlowId(body.mxlAudioFlowId);
        } catch (err) {
          return reply.status(400).send({ error: err instanceof Error ? err.message : 'Invalid MXL source field' });
        }
      }
      const updated: SourceDoc = { ...doc, ...body, updatedAt: new Date().toISOString() };
      await getSourcesDb().insert(updated);
      return reply.send(toApi(updated));
    } catch (err: unknown) {
      if (err && typeof err === 'object' && 'statusCode' in err && (err as { statusCode: number }).statusCode === 404) {
        return reply.status(404).send({ error: 'Source not found', statusCode: 404 });
      }
      throw err;
    }
  });

  // Delete a source
  fastify.delete<{ Params: { id: string } }>('/api/v1/sources/:id', async (req, reply) => {
    try {
      const doc = await getSourcesDb().get(req.params.id);

      // Block deletion if source is used by an active/activating production
      const activeProductions = await getDb().find({
        selector: { type: 'production', status: { $in: ['active', 'activating'] }, 'sources': { $elemMatch: { sourceId: req.params.id } } },
        fields: ['_id', 'name'],
        limit: 1,
      });
      if (activeProductions.docs.length > 0) {
        const prod = activeProductions.docs[0] as unknown as Pick<ProductionDoc, '_id' | 'name'>;
        return reply.status(409).send({ error: `Source is in use by active production "${prod.name}"` });
      }

      // Remove references from inactive productions and record a warning
      const inactiveProductions = await getDb().find({
        selector: { type: 'production', status: 'inactive', 'sources': { $elemMatch: { sourceId: req.params.id } } },
        fields: ['_id', 'name', 'sources', 'deletionWarnings'],
        limit: 100,
      });
      for (const p of inactiveProductions.docs) {
        const prod = p as unknown as ProductionDoc;
        const warnings = prod.deletionWarnings ?? [];
        warnings.push({ type: 'source', name: doc.name });
        await updateProductionDoc(prod._id, {
          sources: prod.sources.filter((s) => s.sourceId !== req.params.id),
          deletionWarnings: warnings,
        });
      }

      await getSourcesDb().destroy(doc._id, doc._rev!);
      return reply.status(204).send();
    } catch (err: unknown) {
      if (err && typeof err === 'object' && 'statusCode' in err && (err as { statusCode: number }).statusCode === 404) {
        return reply.status(404).send({ error: 'Source not found' });
      }
      throw err;
    }
  });
};

export default sourcesRoutes;
