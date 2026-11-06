import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createContext, runInContext } from 'node:vm';

const floatCount = 64;
const timeout = 10_000;
const exportAnchor = '$rt_exports.main = $rt_export_main;';
const scenarios = [
  { name: 'full upload', phases: [] },
  { name: 'prefix partial upload', phases: [[[0, 16, 1000]]] },
  { name: 'middle partial upload', phases: [[[16, 32, 1000]]] },
  { name: 'suffix partial upload', phases: [[[48, 64, 1000]]] },
  { name: 'merged dirty ranges', phases: [[[16, 24, 1000], [40, 56, 2000]]] },
  { name: 'consecutive partial uploads', phases: [[[16, 32, 1000]], [[32, 48, 2000]]] },
  { name: 'clean buffer does not upload', phases: [[[16, 32, 1000]], [], []] },
];

// Load the actual compiled game and its NIO runtime without calling main. Only
// the GPU boundary is replaced; FloatBuffer allocation/copy and VBO updates are
// the shipped implementations. This catches TeaVM bugs that JVM tests cannot.
const probe = String.raw`
$rt_exports.verifyVertexbuffer = (scenarios) => {
  let results;
  $rt_startThread(() => {
    cbg_Gdx_app = {};
    results = scenarios.map((scenario) => {
      let gpu;
      const uploads = [];
      cbg_Gdx_gl = {
        $glBindBuffer() {},
        $glBufferData(target, size, data) {
          const values = Array.from(cgxgtbwdt_TypedArrays_getFloat32Array(data));
          gpu = values.slice();
          uploads.push({ kind: 'full', target, offset: 0, size, values });
        },
        $glBufferSubData(target, offset, size, data) {
          const values = Array.from(cgxgtbwdt_TypedArrays_getFloat32Array(data));
          for (let i = 0; i < values.length; i++) gpu[offset / 4 + i] = values[i];
          uploads.push({ kind: 'partial', target, offset, size, values });
        }
      };
      const vertices = cwg_Quad_createSet(4);
      const cpu = cgxgtbwdt_TypedArrays_getFloat32Array(vertices);
      for (let i = 0; i < cpu.length; i++) cpu[i] = i + 0.25;

      // Skip only GPU resource allocation; updateVertices initializes the
      // actual generated VBO fields and dirty range without field-name stubs.
      const buffer = new cwg_Vertexbuffer();
      jn_Buffer_position(vertices, 11);
      cwg_Vertexbuffer_updateVertices(buffer, vertices);
      cwg_Vertexbuffer_updateGLData(buffer);
      const snapshot = (firstUpload) => ({
        cpu: Array.from(cpu), gpu: gpu.slice(), uploads: uploads.slice(firstUpload),
        position: jn_Buffer_position0(vertices), limit: jn_Buffer_limit0(vertices)
      });
      const initial = snapshot(0);
      const phases = scenario.phases.map((ranges) => {
        const firstUpload = uploads.length;
        jn_Buffer_position(vertices, 61);
        for (const [start, end, delta] of ranges) {
          for (let i = start; i < end; i++) cpu[i] += delta;
          cwg_Vertexbuffer_updateVertices0(buffer, vertices, start, end);
        }
        cwg_Vertexbuffer_updateGLData(buffer);
        return snapshot(firstUpload);
      });
      return {
        name: scenario.name, initial, phases,
        isWeb: !!cwu_DeviceCompat_isWeb(),
        usesTypedArrayBuffer: vertices instanceof jn_FloatBufferOverTypedArray
      };
    });
  });
  if (!results) throw new Error('The rendering probe unexpectedly suspended.');
  return results;
};
`;

function equalFloats(actual, expected, label) {
  assert.ok(Array.isArray(actual), `${label}: expected an array of floats.`);
  assert.equal(actual.length, expected.length, `${label}: incorrect float count.`);
  const mismatch = expected.findIndex((value, index) => actual[index] !== value);
  assert.equal(mismatch, -1, `${label}: float ${mismatch} is ${actual[mismatch]}, expected ${expected[mismatch]}.`);
}

function verifyUpload(upload, expected, start, end, kind, label) {
  assert.equal(upload.kind, kind, `${label}: incorrect upload operation.`);
  assert.equal(upload.target, 34962, `${label}: expected GL_ARRAY_BUFFER.`);
  assert.equal(upload.offset, start * 4, `${label}: incorrect byte offset.`);
  assert.equal(upload.size, (end - start) * 4, `${label}: incorrect byte length.`);
  equalFloats(upload.values, expected.slice(start, end), `${label}: uploaded dirty range`);
}

export function verifyGameRendering(appPath) {
  const source = readFileSync(appPath, 'utf8');
  assert.equal(source.split(exportAnchor).length, 2,
    'Game rendering verification needs the unique TeaVM main export; review the probe after a compiler upgrade.');
  const context = createContext({ exports: {}, scenarios });
  runInContext(source.replace(exportAnchor, probe + '\n' + exportAnchor), context,
    { timeout, filename: resolve(appPath) });
  // Keep the probe execution inside the VM timeout as well as the module load.
  const results = JSON.parse(runInContext('JSON.stringify(exports.verifyVertexbuffer(scenarios))', context,
    { timeout, filename: 'game-rendering-probe' }));
  assert.equal(results.length, scenarios.length, 'The rendering probe did not run every case.');

  for (const [index, scenario] of scenarios.entries()) {
    const result = results[index];
    const expected = Array.from({ length: floatCount }, (_, i) => i + 0.25);
    assert.equal(result.name, scenario.name);
    assert.equal(result.isWeb, true, `${scenario.name}: the Web upload path was not exercised.`);
    assert.equal(result.usesTypedArrayBuffer, true,
      `${scenario.name}: native-order TeaVM FloatBuffer changed; review this regression probe.`);
    assert.equal(result.initial.uploads.length, 1, `${scenario.name}: expected one initial upload.`);
    verifyUpload(result.initial.uploads[0], expected, 0, floatCount, 'full', scenario.name);
    equalFloats(result.initial.cpu, expected, `${scenario.name}: initial CPU vertices`);
    equalFloats(result.initial.gpu, expected, `${scenario.name}: initial GPU vertices`);
    assert.equal(result.initial.position, 0, `${scenario.name}: full upload must rewind the source.`);
    assert.equal(result.initial.limit, floatCount, `${scenario.name}: full upload changed the source limit.`);
    assert.equal(result.phases.length, scenario.phases.length);

    for (const [phaseIndex, ranges] of scenario.phases.entries()) {
      const phase = result.phases[phaseIndex];
      const label = `${scenario.name}, update ${phaseIndex + 1}`;
      for (const [start, end, delta] of ranges) {
        for (let i = start; i < end; i++) expected[i] += delta;
      }
      assert.equal(phase.uploads.length, ranges.length ? 1 : 0, `${label}: incorrect upload count.`);
      if (ranges.length) {
        const start = Math.min(...ranges.map(([start]) => start));
        const end = Math.max(...ranges.map(([, end]) => end));
        verifyUpload(phase.uploads[0], expected, start, end, 'partial', label);
      }
      equalFloats(phase.cpu, expected, `${label}: source vertices changed during upload`);
      equalFloats(phase.gpu, expected, `${label}: GPU vertices differ from the map vertices`);
      assert.equal(phase.position, 61, `${label}: partial upload changed the source position.`);
      assert.equal(phase.limit, floatCount, `${label}: partial upload changed the source limit.`);
    }
  }
  return { caseCount: scenarios.length };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    assert.equal(process.argv.length, 3, 'Usage: node scripts/verify-game-rendering.mjs path/to/app.js');
    const { caseCount } = verifyGameRendering(resolve(process.argv[2]));
    console.log(`Game rendering verification passed: ${caseCount} compiled-runtime cases.`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
