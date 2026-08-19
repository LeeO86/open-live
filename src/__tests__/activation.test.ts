/**
 * Tests for async activation state machine and ICE servers route.
 *
 * CouchDB, Strom client, and flow-generator are mocked — no real services required.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildServer } from '../server.js';
import type { OutputDoc, ProductionDoc, SourceDoc } from '../db/types.js';
import type { StromClient } from '../lib/strom.js';

// ---------------------------------------------------------------------------
// Mock CouchDB
// ---------------------------------------------------------------------------

const mockGet = vi.fn();
const mockInsert = vi.fn();
const mockFind = vi.fn();

vi.mock('../db/index.js', () => ({
  getDb: () => ({ get: mockGet, insert: mockInsert, find: mockFind }),
  getSourcesDb: () => ({ get: mockGet }),
  getGraphicsDb: () => ({ get: mockGet }),
  getOutputsDb: () => ({ get: mockGet }),
  connectDb: vi.fn().mockResolvedValue(undefined),
  isDbReady: vi.fn().mockResolvedValue(true),
  isDbConnected: vi.fn().mockReturnValue(true),
}));

// ---------------------------------------------------------------------------
// Mock WebSocket controller (avoids startup side effects)
// ---------------------------------------------------------------------------

vi.mock('../ws/controller.js', () => ({
  default: async () => {},
  clearPipState: vi.fn(),
  clearAudioState: vi.fn(),
  clearFxState: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Mock flow-generator
// ---------------------------------------------------------------------------

const mockActivateStromFlow = vi.fn();
const mockDeactivateStromFlow = vi.fn();

vi.mock('../lib/flow-generator.js', () => ({
  activateStromFlow: (...args: unknown[]) => mockActivateStromFlow(...args),
  deactivateStromFlow: (...args: unknown[]) => mockDeactivateStromFlow(...args),
}));

// ---------------------------------------------------------------------------
// Mock StromClient
// ---------------------------------------------------------------------------

const mockStromFlowsGet = vi.fn();
const mockStromMixerMultiviewEndpoint = vi.fn();
const mockStromSystemIceServers = vi.fn();
const mockStromSystemVersion = vi.fn();

vi.mock('../lib/strom.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/strom.js')>();
  class MockStromClient {
    system = {
      version: mockStromSystemVersion,
      iceServers: mockStromSystemIceServers,
    };
    flows = {
      get: mockStromFlowsGet,
      start: vi.fn().mockResolvedValue({}),
      stop: vi.fn().mockResolvedValue({}),
      delete: vi.fn().mockResolvedValue({}),
    };
    mixer = {
      multiviewEndpoint: mockStromMixerMultiviewEndpoint,
    };
  }
  return {
    ...actual,
    StromClient: MockStromClient,
  };
});

// Mock strom-token
vi.mock('../lib/strom-token.js', () => ({
  getStromToken: vi.fn().mockResolvedValue('test-token'),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeProductionDoc(overrides: Record<string, unknown> = {}) {
  return {
    _id: 'prod-test-1',
    _rev: '1-abc',
    type: 'production',
    name: 'Test Production',
    status: 'inactive',
    sources: [],
    pipeline: { stromConfig: null, status: 'stopped' },
    graphics: [],
    macros: [],
    tally: { pgm: null, pvw: null },
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests: POST /api/v1/productions/:id/activate
// ---------------------------------------------------------------------------

describe('POST /api/v1/productions/:id/activate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFind.mockResolvedValue({ docs: [] });
  });

  it('returns 200 with status "activating" immediately', async () => {
    const doc = makeProductionDoc();
    mockGet.mockResolvedValue(doc);
    mockInsert.mockResolvedValue({ rev: '2-bcd', ok: true, id: doc._id });
    // The async polling loop will call activateStromFlow — we just let it
    // resolve slowly so it doesn't interfere with this test
    mockActivateStromFlow.mockResolvedValue('flow-abc');
    mockStromFlowsGet.mockResolvedValue({ flow: { id: 'flow-abc', state: 'idle' } });

    const app = await buildServer();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/productions/prod-test-1/activate',
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.status).toBe('activating');
    expect(body.id).toBe('prod-test-1');
  });

  it('returns 409 if production is already active', async () => {
    const doc = makeProductionDoc({ status: 'active' });
    mockGet.mockResolvedValue(doc);

    const app = await buildServer();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/productions/prod-test-1/activate',
    });

    expect(res.statusCode).toBe(409);
    const body = JSON.parse(res.body);
    expect(body.error).toContain("already 'active'");
  });

  it('returns 409 if production is already activating', async () => {
    const doc = makeProductionDoc({ status: 'activating' });
    mockGet.mockResolvedValue(doc);

    const app = await buildServer();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/productions/prod-test-1/activate',
    });

    expect(res.statusCode).toBe(409);
    const body = JSON.parse(res.body);
    expect(body.error).toContain("already 'activating'");
  });

  it('returns 500 if CouchDB write fails', async () => {
    const doc = makeProductionDoc();
    mockGet.mockResolvedValue(doc);
    mockInsert.mockRejectedValue(new Error('CouchDB connection error'));

    const app = await buildServer();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/productions/prod-test-1/activate',
    });

    expect(res.statusCode).toBe(500);
  });
});

// ---------------------------------------------------------------------------
// Tests: POST /api/v1/productions/:id/deactivate
// ---------------------------------------------------------------------------

describe('POST /api/v1/productions/:id/deactivate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFind.mockResolvedValue({ docs: [] });
  });

  it('clears whepEndpoint, stromFlowId, and mixerBlockId on deactivate', async () => {
    const doc = makeProductionDoc({
      status: 'active',
      stromFlowId: 'flow-abc',
      mixerBlockId: 'mixer-1',
      whepEndpoint: 'https://strom.example.com/whep/flow-abc/mixer-1',
    });
    mockGet.mockResolvedValue(doc);
    mockDeactivateStromFlow.mockResolvedValue(undefined);
    mockInsert.mockResolvedValue({ rev: '3-cde', ok: true, id: doc._id });

    const app = await buildServer();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/productions/prod-test-1/deactivate',
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.status).toBe('inactive');

    // Verify the doc written to CouchDB cleared the fields
    const insertedDoc = mockInsert.mock.calls[0][0];
    expect(insertedDoc.whepEndpoint).toBeUndefined();
    expect(insertedDoc.stromFlowId).toBeUndefined();
    expect(insertedDoc.mixerBlockId).toBeUndefined();
  });

  it('returns 200 even if production has no stromFlowId', async () => {
    const doc = makeProductionDoc({ status: 'inactive' });
    mockGet.mockResolvedValue(doc);
    mockInsert.mockResolvedValue({ rev: '2-bcd', ok: true, id: doc._id });

    const app = await buildServer();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/productions/prod-test-1/deactivate',
    });

    expect(res.statusCode).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Tests: GET /api/v1/ice-servers
// ---------------------------------------------------------------------------

describe('GET /api/v1/ice-servers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFind.mockResolvedValue({ docs: [] });
  });

  it('returns 502 if Strom is unreachable', async () => {
    mockStromSystemIceServers.mockRejectedValue(new Error('connect ECONNREFUSED'));

    const app = await buildServer();
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/ice-servers',
    });

    expect(res.statusCode).toBe(502);
    const body = JSON.parse(res.body);
    expect(body.statusCode).toBe(502);
  });

  it('returns 502 if Strom returns a StromClientError', async () => {
    const { StromClientError } = await import('../lib/strom.js');
    mockStromSystemIceServers.mockRejectedValue(new StromClientError(503, 'Service unavailable'));

    const app = await buildServer();
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/ice-servers',
    });

    expect(res.statusCode).toBe(502);
  });

  it('returns 200 with iceServers array from Strom', async () => {
    mockStromSystemIceServers.mockResolvedValue({
      ice_servers: [
        { urls: ['turn:turn.example.com:3478'], username: 'user', credential: 'pass' },
        { urls: ['stun:stun.example.com:3478'] },
      ],
    });

    const app = await buildServer();
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/ice-servers',
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.iceServers).toHaveLength(2);
    expect(body.iceServers[0].urls).toContain('turn:turn.example.com:3478');
    expect(body.iceServers[0].username).toBe('user');
    expect(body.iceServers[0].credential).toBe('pass');
  });
});

// ---------------------------------------------------------------------------
// Tests: flow-generator MXL / DeckLink injection
// ---------------------------------------------------------------------------

const SRT_URI = 'srt://192.0.2.10:9000?mode=caller';
const MXL_VIDEO_ID = '11111111-1111-4111-8111-111111111111';
const MXL_AUDIO_ID = '22222222-2222-4222-8222-222222222222';
const MXL_PGM_ID = '33333333-3333-4333-8333-333333333333';
const MXL_MV_ID = '44444444-4444-4444-8444-444444444444';
const MXL_PGM_AUDIO_ID = '55555555-5555-4555-8555-555555555555';
const MXL_MV_AUDIO_ID = '66666666-6666-4666-8666-666666666666';

type GeneratedFlow = {
  blocks: Array<Record<string, unknown>>;
  links: Array<{ from: string; to: string }>;
  elements: Array<Record<string, unknown>>;
};

function makeSourceDoc(overrides: Partial<SourceDoc> & Pick<SourceDoc, 'streamType' | 'address'>): SourceDoc {
  return {
    _id: overrides._id ?? 'src-1',
    type: 'source',
    name: overrides.name ?? 'Cam',
    status: 'inactive',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function makeOutput(overrides: Partial<OutputDoc> & Pick<OutputDoc, 'outputType'>): OutputDoc {
  return {
    _id: overrides._id ?? 'output-1',
    type: 'output',
    name: overrides.name ?? 'Out',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function blockByDef(flow: GeneratedFlow, def: string): Record<string, unknown>[] {
  return flow.blocks.filter((b) => b['block_definition_id'] === def);
}

function mixerId(flow: GeneratedFlow): string {
  return blockByDef(flow, 'builtin.vision_mixer')[0]!['id'] as string;
}

function audioMixerId(flow: GeneratedFlow): string {
  return blockByDef(flow, 'builtin.mixer')[0]!['id'] as string;
}

describe('flow-generator MXL and DeckLink injection', () => {
  let activateStromFlow: typeof import('../lib/flow-generator.js').activateStromFlow;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockFind.mockResolvedValue({ docs: [] });
    const actual = await vi.importActual<typeof import('../lib/flow-generator.js')>('../lib/flow-generator.js');
    activateStromFlow = actual.activateStromFlow;
  });

  async function generateFlow(
    sources: SourceDoc[],
    assignments: Array<{ sourceId: string; mixerInput: string }>,
    outputs?: OutputDoc[],
    values?: Record<string, string | number | boolean>,
  ): Promise<GeneratedFlow> {
    const byId = new Map(sources.map((s) => [s._id, s]));
    mockGet.mockImplementation(async (id: string) => {
      const src = byId.get(id);
      if (!src) {
        const err = Object.assign(new Error('not found'), { statusCode: 404 });
        throw err;
      }
      return src;
    });

    let created: GeneratedFlow | undefined;
    const strom = {
      flows: {
        create: vi.fn(async (body: GeneratedFlow) => {
          created = body;
          return { flow: { id: 'flow-test' } };
        }),
        start: vi.fn(async () => ({})),
        delete: vi.fn(async () => ({})),
      },
    };

    const production = makeProductionDoc({
      sources: assignments,
      values,
    }) as unknown as ProductionDoc;

    await activateStromFlow(
      production,
      strom as unknown as StromClient,
      undefined,
      outputs,
    );
    if (!created) throw new Error('Strom flows.create was not called');
    return created;
  }

  it('injects srt-only input with audio_out_0', async () => {
    const src = makeSourceDoc({
      _id: 'src-srt',
      name: 'SRT Cam',
      streamType: 'srt',
      address: SRT_URI,
      latency: 200,
    });
    const flow = await generateFlow([src], [{ sourceId: 'src-srt', mixerInput: 'video_in_0' }]);
    const input = blockByDef(flow, 'builtin.mpegtssrt_input')[0]!;
    expect(input['block_definition_id']).toBe('builtin.mpegtssrt_input');
    expect((input['properties'] as Record<string, unknown>)['srt_uri']).toBe(SRT_URI);
    expect((input['properties'] as Record<string, unknown>)['latency']).toBe(200);
    const offset = flow.blocks.find((b) => b['name'] === 'Offset V0')!;
    expect(flow.links).toContainEqual({ from: `${input['id']}:video_out`, to: `${offset['id']}:in` });
    expect(flow.links.some((l) => l.from === `${input['id']}:audio_out_0`)).toBe(true);
    expect(flow.links.some((l) => l.from === `${input['id']}:audio_out`)).toBe(false);
    expect((audioMixerId(flow) && (blockByDef(flow, 'builtin.mixer')[0]!['properties'] as Record<string, unknown>)['num_channels'])).toBe(1);
    expect((blockByDef(flow, 'builtin.vision_mixer')[0]!['properties'] as Record<string, unknown>)['min_upstream_latency']).toBe(200);
  });

  it('injects mxl-only video input without videoformat', async () => {
    const src = makeSourceDoc({
      _id: 'src-mxl',
      name: 'MXL Cam',
      streamType: 'mxl',
      address: MXL_VIDEO_ID,
      mxlDomain: '/dev/shm/mxl',
      mxlBackend: 'auto',
    });
    const flow = await generateFlow([src], [{ sourceId: 'src-mxl', mixerInput: 'video_in_0' }]);
    const input = blockByDef(flow, 'builtin.mxl_video_input')[0]!;
    expect(input).toBeDefined();
    const props = input['properties'] as Record<string, unknown>;
    expect(props['video_flow_id']).toBe(MXL_VIDEO_ID);
    expect(props['domain']).toBe('/dev/shm/mxl');
    expect(props['backend']).toBe('auto');
    expect(blockByDef(flow, 'builtin.mxl_audio_input')).toHaveLength(0);
    const offset = flow.blocks.find((b) => b['name'] === 'Offset V0')!;
    expect(flow.links).toContainEqual({ from: `${input['id']}:video_out`, to: `${offset['id']}:in` });
    const toOffset = flow.links.filter((l) => l.to === `${offset['id']}:in`);
    expect(toOffset).toHaveLength(1);
    expect(toOffset[0]!.from).toBe(`${input['id']}:video_out`);
    for (const fmt of blockByDef(flow, 'builtin.videoformat')) {
      expect(flow.links.some((l) => l.from.startsWith(`${fmt['id']}:`) && l.to === `${offset['id']}:in`)).toBe(false);
    }
    expect((blockByDef(flow, 'builtin.mixer')[0]!['properties'] as Record<string, unknown>)['num_channels']).toBe(1);
  });

  it('injects mxl audio_out (not audio_out_0) when mxlAudioFlowId is set', async () => {
    const src = makeSourceDoc({
      _id: 'src-mxl',
      name: 'MXL Cam',
      streamType: 'mxl',
      address: `mxl://${MXL_VIDEO_ID}`,
      mxlAudioFlowId: MXL_AUDIO_ID,
    });
    const flow = await generateFlow([src], [{ sourceId: 'src-mxl', mixerInput: 'video_in_0' }]);
    const audioIn = blockByDef(flow, 'builtin.mxl_audio_input')[0]!;
    expect((audioIn['properties'] as Record<string, unknown>)['audio_flow_id']).toBe(MXL_AUDIO_ID);
    expect(flow.links.some((l) => l.from === `${audioIn['id']}:audio_out`)).toBe(true);
    expect(flow.links.some((l) => l.from === `${audioIn['id']}:audio_out_0`)).toBe(false);
    expect((blockByDef(flow, 'builtin.mixer')[0]!['properties'] as Record<string, unknown>)['num_channels']).toBe(1);
  });

  it('injects decklink-only input with videoformat between card and offset', async () => {
    const src = makeSourceDoc({
      _id: 'src-dl',
      name: 'SDI 1',
      streamType: 'decklink',
      address: '0',
      decklinkMode: '1080p50',
      decklinkConnection: 'sdi',
    });
    const flow = await generateFlow(
      [src],
      [{ sourceId: 'src-dl', mixerInput: 'video_in_0' }],
      undefined,
      { pgm_resolution: '1920x1080' },
    );
    const input = blockByDef(flow, 'builtin.decklink_input')[0]!;
    const props = input['properties'] as Record<string, unknown>;
    expect(props['device_number']).toBe(0);
    expect(props['stream_mode']).toBe('audio_video');
    expect(props['mode']).toBe('1080p50');
    expect(props['connection']).toBe('sdi');
    const fmt = blockByDef(flow, 'builtin.videoformat').find((b) => b['name'] === 'Format V0')!;
    expect((fmt['properties'] as Record<string, unknown>)['resolution']).toBe('1920x1080');
    const offset = flow.blocks.find((b) => b['name'] === 'Offset V0')!;
    expect(flow.links).toContainEqual({ from: `${input['id']}:video_out`, to: `${fmt['id']}:video_in` });
    expect(flow.links).toContainEqual({ from: `${fmt['id']}:video_out`, to: `${offset['id']}:in` });
    expect(flow.links.some((l) => l.from === `${input['id']}:audio_out`)).toBe(true);
    expect(flow.links.some((l) => l.from === `${input['id']}:audio_out_0`)).toBe(false);
  });

  it('injects mixed srt + mxl + decklink on different mixer pads', async () => {
    const sources = [
      makeSourceDoc({ _id: 'src-srt', name: 'SRT', streamType: 'srt', address: SRT_URI, latency: 400 }),
      makeSourceDoc({ _id: 'src-mxl', name: 'MXL', streamType: 'mxl', address: MXL_VIDEO_ID }),
      makeSourceDoc({ _id: 'src-dl', name: 'SDI', streamType: 'decklink', address: '1' }),
    ];
    const flow = await generateFlow(sources, [
      { sourceId: 'src-srt', mixerInput: 'video_in_0' },
      { sourceId: 'src-mxl', mixerInput: 'video_in_1' },
      { sourceId: 'src-dl', mixerInput: 'video_in_2' },
    ]);
    expect(blockByDef(flow, 'builtin.mpegtssrt_input')).toHaveLength(1);
    expect(blockByDef(flow, 'builtin.mxl_video_input')).toHaveLength(1);
    expect(blockByDef(flow, 'builtin.decklink_input')).toHaveLength(1);
    const srt = blockByDef(flow, 'builtin.mpegtssrt_input')[0]!;
    const mxl = blockByDef(flow, 'builtin.mxl_video_input')[0]!;
    const dl = blockByDef(flow, 'builtin.decklink_input')[0]!;
    expect(flow.links.some((l) => l.from === `${srt['id']}:audio_out_0`)).toBe(true);
    expect(flow.links.some((l) => l.from === `${mxl['id']}:audio_out`)).toBe(false);
    expect(flow.links.some((l) => l.from === `${dl['id']}:audio_out`)).toBe(true);
    // mxl video-only must not increment audio mixer; srt + decklink = 2
    expect((blockByDef(flow, 'builtin.mixer')[0]!['properties'] as Record<string, unknown>)['num_channels']).toBe(2);
    expect((blockByDef(flow, 'builtin.vision_mixer')[0]!['properties'] as Record<string, unknown>)['min_upstream_latency']).toBe(400);
    const mixer = mixerId(flow);
    expect((blockByDef(flow, 'builtin.vision_mixer')[0]!['properties'] as Record<string, unknown>)['gl_download']).toBeUndefined();
    expect(flow.links.some((l) => l.to === `${mixer}:video_in_0`)).toBe(true);
    expect(flow.links.some((l) => l.to === `${mixer}:video_in_1`)).toBe(true);
    expect(flow.links.some((l) => l.to === `${mixer}:video_in_2`)).toBe(true);
  });

  it('wires mxl PGM output from mixer pgm_out, not Enc PGM', async () => {
    const src = makeSourceDoc({ _id: 'src-srt', streamType: 'srt', address: SRT_URI });
    const out = makeOutput({
      _id: 'output-mxl-pgm',
      name: 'MXL PGM',
      outputType: 'mxl',
      url: MXL_PGM_ID,
      mxlTap: 'pgm',
    });
    const flow = await generateFlow([src], [{ sourceId: 'src-srt', mixerInput: 'video_in_0' }], [out]);
    const mxlOut = blockByDef(flow, 'builtin.mxl_video_output')[0]!;
    expect((mxlOut['properties'] as Record<string, unknown>)['flow_id']).toBe(MXL_PGM_ID);
    const mixer = mixerId(flow);
    expect(flow.links).toContainEqual({ from: `${mixer}:pgm_out`, to: `${mxlOut['id']}:video_in` });
    const encPgm = flow.blocks.find((b) => b['name'] === 'Enc PGM')!;
    expect(flow.links.some((l) => l.from === `${encPgm['id']}:encoded_out` && l.to === `${mxlOut['id']}:video_in`)).toBe(false);
    expect(flow.links).toContainEqual({ from: `${mixer}:pgm_out`, to: `${encPgm['id']}:video_in` });
  });

  it('wires mxl multiview output from mixer multiview_out, not Enc MV', async () => {
    const src = makeSourceDoc({ _id: 'src-srt', streamType: 'srt', address: SRT_URI });
    const out = makeOutput({
      _id: 'output-mxl-mv',
      name: 'MXL MV',
      outputType: 'mxl',
      url: MXL_MV_ID,
      mxlTap: 'multiview',
    });
    const flow = await generateFlow([src], [{ sourceId: 'src-srt', mixerInput: 'video_in_0' }], [out]);
    const mxlOut = blockByDef(flow, 'builtin.mxl_video_output')[0]!;
    const mixer = mixerId(flow);
    const encMv = flow.blocks.find((b) => b['name'] === 'Enc MV')!;
    expect(flow.links).toContainEqual({ from: `${mixer}:multiview_out`, to: `${mxlOut['id']}:video_in` });
    expect(flow.links.some((l) => l.from === `${encMv['id']}:encoded_out` && l.to === `${mxlOut['id']}:video_in`)).toBe(false);
    expect(flow.links).toContainEqual({ from: `${mixer}:multiview_out`, to: `${encMv['id']}:video_in` });
  });

  it('fans out two MXL outputs (PGM + MV) while keeping Enc PGM/Enc MV WHEP', async () => {
    const src = makeSourceDoc({ _id: 'src-srt', streamType: 'srt', address: SRT_URI });
    const outputs = [
      makeOutput({ _id: 'output-mxl-pgm', name: 'MXL PGM', outputType: 'mxl', url: MXL_PGM_ID, mxlTap: 'pgm' }),
      makeOutput({ _id: 'output-mxl-mv', name: 'MXL MV', outputType: 'mxl', url: MXL_MV_ID, mxlTap: 'multiview' }),
      makeOutput({ _id: 'output-srt', name: 'SRT Out', outputType: 'mpegtssrt', url: 'srt://192.0.2.20:6000?mode=listener' }),
    ];
    const flow = await generateFlow([src], [{ sourceId: 'src-srt', mixerInput: 'video_in_0' }], outputs);
    const mxlVideos = blockByDef(flow, 'builtin.mxl_video_output');
    expect(mxlVideos).toHaveLength(2);
    const flowIds = mxlVideos.map((b) => (b['properties'] as Record<string, unknown>)['flow_id']);
    expect(new Set(flowIds)).toEqual(new Set([MXL_PGM_ID, MXL_MV_ID]));
    const mixer = mixerId(flow);
    const pgmBlock = mxlVideos.find((b) => (b['properties'] as Record<string, unknown>)['flow_id'] === MXL_PGM_ID)!;
    const mvBlock = mxlVideos.find((b) => (b['properties'] as Record<string, unknown>)['flow_id'] === MXL_MV_ID)!;
    expect(flow.links).toContainEqual({ from: `${mixer}:pgm_out`, to: `${pgmBlock['id']}:video_in` });
    expect(flow.links).toContainEqual({ from: `${mixer}:multiview_out`, to: `${mvBlock['id']}:video_in` });
    const encPgm = flow.blocks.find((b) => b['name'] === 'Enc PGM')!;
    const encMv = flow.blocks.find((b) => b['name'] === 'Enc MV')!;
    const whepPgm = flow.blocks.find((b) => b['name'] === 'PGM Output')!;
    const whepMv = flow.blocks.find((b) => b['name'] === 'Multiview Output')!;
    expect(flow.links).toContainEqual({ from: `${mixer}:pgm_out`, to: `${encPgm['id']}:video_in` });
    expect(flow.links).toContainEqual({ from: `${mixer}:multiview_out`, to: `${encMv['id']}:video_in` });
    expect(flow.links).toContainEqual({ from: `${encPgm['id']}:encoded_out`, to: `${whepPgm['id']}:video_in` });
    expect(flow.links).toContainEqual({ from: `${encMv['id']}:encoded_out`, to: `${whepMv['id']}:video_in` });
    const srtOut = blockByDef(flow, 'builtin.mpegtssrt_output')[0]!;
    expect(flow.links).toContainEqual({ from: `${encPgm['id']}:encoded_out`, to: `${srtOut['id']}:video_in` });
  });

  it('injects optional MXL audio outputs from main_out and monitor_out', async () => {
    const src = makeSourceDoc({ _id: 'src-srt', streamType: 'srt', address: SRT_URI });
    const outputs = [
      makeOutput({
        _id: 'output-mxl-pgm',
        name: 'MXL PGM',
        outputType: 'mxl',
        url: MXL_PGM_ID,
        mxlTap: 'pgm',
        mxlAudioFlowId: MXL_PGM_AUDIO_ID,
        mxlAudioSource: 'main',
      }),
      makeOutput({
        _id: 'output-mxl-mv',
        name: 'MXL MV',
        outputType: 'mxl',
        url: MXL_MV_ID,
        mxlTap: 'multiview',
        mxlAudioFlowId: MXL_MV_AUDIO_ID,
        mxlAudioSource: 'monitor',
      }),
    ];
    const flow = await generateFlow([src], [{ sourceId: 'src-srt', mixerInput: 'video_in_0' }], outputs);
    const audioOuts = blockByDef(flow, 'builtin.mxl_audio_output');
    expect(audioOuts).toHaveLength(2);
    const am = audioMixerId(flow);
    const mainAudio = audioOuts.find((b) => (b['properties'] as Record<string, unknown>)['flow_id'] === MXL_PGM_AUDIO_ID)!;
    const monAudio = audioOuts.find((b) => (b['properties'] as Record<string, unknown>)['flow_id'] === MXL_MV_AUDIO_ID)!;
    expect(flow.links).toContainEqual({ from: `${am}:main_out`, to: `${mainAudio['id']}:audio_in` });
    expect(flow.links).toContainEqual({ from: `${am}:monitor_out`, to: `${monAudio['id']}:audio_in` });
  });

  it('skips MXL output with empty url', async () => {
    const src = makeSourceDoc({ _id: 'src-srt', streamType: 'srt', address: SRT_URI });
    const out = makeOutput({ _id: 'output-mxl-empty', name: 'MXL empty', outputType: 'mxl', url: '' });
    const flow = await generateFlow([src], [{ sourceId: 'src-srt', mixerInput: 'video_in_0' }], [out]);
    expect(blockByDef(flow, 'builtin.mxl_video_output')).toHaveLength(0);
    expect(blockByDef(flow, 'builtin.mxl_audio_output')).toHaveLength(0);
  });
});
