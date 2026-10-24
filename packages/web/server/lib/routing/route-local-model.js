/**
 * The local interpreter: a small instruction model that answers the choice
 * questions in `route-interpreter.js`, constrained to the allowed answers by a
 * JSON grammar so it cannot reply with anything else. It is only downloaded when
 * the user asks for it in Settings, and `node-llama-cpp` is loaded lazily, so
 * OpenChamber runs without either.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * The interpreter's model. `url` names one Hugging Face commit, so `sha256`
 * (the file's LFS digest at that commit) always describes the same bytes. A
 * model without a digest is never downloaded.
 */
export const LOCAL_MODEL = {
  id: 'qwen2.5-1.5b-instruct-q4_k_m',
  label: 'Qwen2.5 1.5B Instruct (Q4_K_M)',
  file: 'qwen2.5-1.5b-instruct-q4_k_m.gguf',
  url: 'https://huggingface.co/Qwen/Qwen2.5-1.5B-Instruct-GGUF/resolve/91cad51170dc346986eccefdc2dd33a9da36ead9/qwen2.5-1.5b-instruct-q4_k_m.gguf',
  bytes: 1117320736,
  sha256: '6a1a2eb6d15622bf3c96857206351ba97e1af16c30d7a74ee38970e434e9407e',
};

/** Refuses a model that has no pinned digest, before anything is fetched or written. */
export const assertVerifiable = (model = LOCAL_MODEL) => {
  if (!model.sha256) {
    throw Object.assign(new Error('No checksum is pinned for the local model in this build, so it cannot be downloaded safely'), { status: 409 });
  }
};

const modelsDir = (env = process.env) => {
  const base = env.XDG_CACHE_HOME?.trim() || path.join(os.homedir(), '.cache');
  return path.join(base, 'openchamber', 'models');
};

export const modelPath = (env) => path.join(modelsDir(env), LOCAL_MODEL.file);

export const modelStatus = (file = modelPath(), model = LOCAL_MODEL) => {
  let size = 0;
  try {
    size = fs.statSync(file).size;
  } catch {
    size = 0;
  }
  return {
    ...model,
    path: file,
    installed: size === model.bytes,
    downloadedBytes: size,
  };
};

/**
 * Downloads the model to a partial file. The partial file becomes the model
 * only when its size and SHA-256 both match the model's pinned values;
 * otherwise it is discarded and the error says why.
 */
export const downloadModel = async ({ file = modelPath(), model = LOCAL_MODEL, fetchImpl = fetch, onProgress = () => {} } = {}) => {
  if (modelStatus(file, model).installed) return modelStatus(file, model);
  assertVerifiable(model);
  const response = await fetchImpl(model.url);
  if (!response.ok || !response.body) {
    throw Object.assign(new Error(`Model download failed (${response.status})`), { status: 502 });
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const partial = `${file}.part`;
  const out = fs.createWriteStream(partial);
  const digest = createHash('sha256');
  let received = 0;
  try {
    for await (const chunk of response.body) {
      received += chunk.length;
      // The pinned size is known before the fetch, so an over-long body is
      // refused the moment it passes that size instead of being written to
      // disk in full and only then discarded: a broken or hostile endpoint
      // could otherwise fill the cache disk without bound.
      if (received > model.bytes) {
        throw Object.assign(
          new Error(`The model download was larger than the expected ${model.bytes} bytes, so it was discarded; try again`),
          { status: 502 },
        );
      }
      digest.update(chunk);
      if (!out.write(chunk)) await new Promise((resolve) => out.once('drain', resolve));
      onProgress(received, model.bytes);
    }
    await new Promise((resolve, reject) => out.end((error) => (error ? reject(error) : resolve())));
  } catch (error) {
    out.destroy();
    fs.rmSync(partial, { force: true });
    throw error;
  }
  if (received !== model.bytes) {
    fs.rmSync(partial, { force: true });
    throw Object.assign(new Error('The model download was incomplete; try again'), { status: 502 });
  }
  if (digest.digest('hex') !== model.sha256) {
    fs.rmSync(partial, { force: true });
    throw Object.assign(new Error('The model download did not match its checksum, so it was discarded; try again'), { status: 502 });
  }
  fs.renameSync(partial, file);
  return modelStatus(file, model);
};

/**
 * Answers the choice questions with the local model. `loadLlama` is injected so
 * tests can run without the native runtime; the real one loads `node-llama-cpp`.
 */
export const createLocalAnswerer = ({ file = modelPath(), loadLlama = defaultLoadLlama } = {}) => {
  let runtime;
  const ready = () => {
    runtime ??= (async () => {
      const llama = await loadLlama();
      const model = await llama.loadModel({ modelPath: file });
      const context = await model.createContext({ contextSize: 1024 });
      return { llama, context };
    })().catch((error) => {
      runtime = undefined;
      throw error;
    });
    return runtime;
  };

  return {
    /** Resolves to the answer for each question key, or throws when the model cannot run. */
    answer: async ({ prompt, schema }) => {
      const { llama, context } = await ready();
      const { LlamaChatSession } = await loadLlamaChat();
      const session = new LlamaChatSession({
        contextSequence: context.getSequence(),
        systemPrompt:
          'You classify one sentence about which AI model providers to use. Answer only with the JSON object that matches the schema.',
      });
      try {
        const grammar = await llama.createGrammarForJsonSchema(schema);
        const raw = await session.prompt(prompt, { grammar, maxTokens: 120, temperature: 0 });
        return JSON.parse(raw);
      } finally {
        session.dispose({ disposeSequence: true });
      }
    },
  };
};

const defaultLoadLlama = async () => {
  const { getLlama } = await import('node-llama-cpp');
  return getLlama();
};

const loadLlamaChat = () => import('node-llama-cpp');
