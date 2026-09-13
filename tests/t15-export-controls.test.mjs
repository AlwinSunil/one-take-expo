import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import typescript from 'typescript';
import * as actualExportPlan from '../src/lib/export-plan.ts';

const require = createRequire(import.meta.url);
const repositoryRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const hostComponents = new Set();

function host(name) {
  const component = function HostComponent() {
    return null;
  };
  Object.defineProperty(component, 'displayName', { value: name });
  hostComponents.add(component);
  return component;
}

const ActivityIndicator = host('ActivityIndicator');
const Pressable = host('Pressable');
const Switch = host('Switch');
const Text = host('Text');
const View = host('View');

const jsxRuntime = {
  Fragment: Symbol('Fragment'),
  jsx(type, props, key) {
    return { type, props: key === undefined ? props ?? {} : { ...(props ?? {}), key } };
  },
  jsxs(type, props, key) {
    return { type, props: key === undefined ? props ?? {} : { ...(props ?? {}), key } };
  },
};

const hookDispatcher = { current: null };
const reactRuntime = {
  useCallback(callback, dependencies) {
    return hookDispatcher.current.useMemo(() => callback, dependencies);
  },
  useEffect(effect, dependencies) {
    return hookDispatcher.current.useEffect(effect, dependencies);
  },
  useMemo(factory, dependencies) {
    return hookDispatcher.current.useMemo(factory, dependencies);
  },
  useRef(initialValue) {
    return hookDispatcher.current.useRef(initialValue);
  },
  useState(initialValue) {
    return hookDispatcher.current.useState(initialValue);
  },
};

function loadTranspiledModule(relativeFile, mocks, cache = new Map()) {
  const filename = path.resolve(repositoryRoot, relativeFile);
  if (cache.has(filename)) return cache.get(filename).exports;

  const source = fs.readFileSync(filename, 'utf8');
  const output = typescript.transpileModule(source, {
    compilerOptions: {
      esModuleInterop: true,
      jsx: typescript.JsxEmit.ReactJSX,
      module: typescript.ModuleKind.CommonJS,
      target: typescript.ScriptTarget.ES2022,
    },
    fileName: filename,
  }).outputText;
  const module = { exports: {} };
  cache.set(filename, module);

  function localRequire(specifier) {
    if (specifier in mocks) return mocks[specifier];
    if (specifier === 'react/jsx-runtime') return jsxRuntime;
    if (specifier.startsWith('.')) {
      const candidate = path.resolve(path.dirname(filename), specifier);
      const candidates = [candidate, `${candidate}.ts`, `${candidate}.tsx`, `${candidate}.js`];
      const resolved = candidates.find(candidatePath => fs.existsSync(candidatePath));
      if (!resolved) throw new Error(`Cannot resolve ${specifier} from ${filename}`);
      return loadTranspiledModule(path.relative(repositoryRoot, resolved), mocks, cache);
    }
    return require(specifier);
  }

  const evaluate = new Function('require', 'module', 'exports', '__filename', '__dirname', output);
  evaluate(localRequire, module, module.exports, filename, path.dirname(filename));
  return module.exports;
}

class HookRenderer {
  #component;
  #props;
  #slots = [];
  #effects = [];
  #pendingEffects = [];
  #hookIndex = 0;
  #dirty = true;
  #mounted = true;
  #output = null;

  constructor(component, props) {
    this.#component = component;
    this.#props = props;
    this.#render();
  }

  get output() {
    return this.#output;
  }

  update(props) {
    this.#props = props;
    this.#dirty = true;
  }

  async flush(iterations = 40) {
    for (let index = 0; index < iterations; index += 1) {
      await Promise.resolve();
      if (this.#dirty) {
        this.#dirty = false;
        this.#render();
      }
    }
  }

  unmount() {
    this.#mounted = false;
    for (const slot of this.#effects) slot?.cleanup?.();
  }

  useRef(initialValue) {
    const index = this.#hookIndex++;
    const slot = this.#slots[index];
    if (slot?.kind === 'ref') return slot.value;
    const value = { current: initialValue };
    this.#slots[index] = { kind: 'ref', value };
    return value;
  }

  useState(initialValue) {
    const index = this.#hookIndex++;
    const slot = this.#slots[index];
    if (slot?.kind === 'state') return [slot.value, slot.setValue];
    const value = typeof initialValue === 'function' ? initialValue() : initialValue;
    const stateSlot = { kind: 'state', value, setValue: null };
    stateSlot.setValue = nextValue => {
      if (!this.#mounted) return;
      const next = typeof nextValue === 'function' ? nextValue(stateSlot.value) : nextValue;
      if (Object.is(next, stateSlot.value)) return;
      stateSlot.value = next;
      this.#dirty = true;
    };
    this.#slots[index] = stateSlot;
    return [stateSlot.value, stateSlot.setValue];
  }

  useMemo(factory, dependencies) {
    const index = this.#hookIndex++;
    const slot = this.#slots[index];
    if (slot?.kind === 'memo' && sameDependencies(slot.dependencies, dependencies)) return slot.value;
    const value = factory();
    this.#slots[index] = { kind: 'memo', dependencies, value };
    return value;
  }

  useEffect(effect, dependencies) {
    const index = this.#hookIndex++;
    const previous = this.#effects[index];
    if (previous && sameDependencies(previous.dependencies, dependencies)) return;
    previous?.cleanup?.();
    this.#effects[index] = { dependencies, cleanup: null };
    this.#pendingEffects.push({ index, effect });
  }

  #render() {
    this.#hookIndex = 0;
    hookDispatcher.current = this;
    this.#output = this.#component(this.#props);
    hookDispatcher.current = null;
    const pending = this.#pendingEffects;
    this.#pendingEffects = [];
    for (const { index, effect } of pending) this.#effects[index].cleanup = effect() ?? null;
  }
}

function sameDependencies(left, right) {
  if (left === undefined || right === undefined) return false;
  if (left.length !== right.length) return false;
  return left.every((value, index) => Object.is(value, right[index]));
}

function walk(node, visit, result = []) {
  if (node === null || node === undefined || typeof node !== 'object') return result;
  if (Array.isArray(node)) {
    node.forEach(child => walk(child, visit, result));
    return result;
  }
  if (visit(node)) result.push(node);
  if (typeof node.type === 'function' && !hostComponents.has(node.type)) {
    walk(node.type(node.props), visit, result);
    return result;
  }
  walk(node.props?.children, visit, result);
  return result;
}

function findByAccessibilityLabel(output, label) {
  return walk(output, node => node.props?.accessibilityLabel === label)[0] ?? null;
}

function textContent(output) {
  const values = [];
  walk(output, node => {
    if (node.type === Text && typeof node.props?.children === 'string') values.push(node.props.children);
    return false;
  });
  return values.join(' ');
}

function makePlan(overrides = {}) {
  const sourceUri = 'file:///source.mp4';
  return {
    timelineRevision: 3,
    burnIntoExport: true,
    sourceUri,
    cuts: [],
    captions: [],
    captionTiming: 'none',
    hasEstimatedCaptions: false,
    segments: [{ uri: sourceUri, t0: 0, t1: 4, captions: [] }],
    ...overrides,
  };
}

function makeProject(overrides = {}) {
  return {
    id: 'project-ui',
    mode: 'assisted',
    videoUri: 'file:///source.mp4',
    clips: [],
    transcript: [],
    createdAt: 1,
    duration: 4,
    recordings: [{ id: 'source', mediaUri: 'file:///source.mp4', duration: 4, createdAt: 1 }],
    availableMediaUris: ['file:///source.mp4'],
    refinement: { status: 'ready', model: 'tiny' },
    ...overrides,
  };
}

function makeMedia({ savedExportId = '', getExport, startExport } = {}) {
  const calls = {
    startExport: [],
    getExport: [],
    cancelExport: [],
    openExport: [],
    saveToGallery: [],
    shareExport: [],
  };
  const media = {
    supportsFraming: true,
    async startExport(request) {
      calls.startExport.push(structuredClone(request));
      return startExport ? startExport(request) : { id: request.id };
    },
    async getExport(id) {
      calls.getExport.push(id);
      if (getExport) return getExport(id, calls);
      return { id, status: 'completed', progress: 1, uri: `file:///${id}.mp4` };
    },
    async cancelExport(id) {
      calls.cancelExport.push(id);
    },
    async openExport(id) {
      calls.openExport.push(id);
    },
    async saveToGallery(id) {
      calls.saveToGallery.push(id);
      return `content://gallery/${id}`;
    },
    async shareExport(id) {
      calls.shareExport.push(id);
    },
  };
  return { calls, media, savedExportId };
}

function makeEnvironment(mediaState) {
  const alerts = [];
  const settings = new Map();
  if (mediaState.savedExportId) settings.set('export:project-ui', mediaState.savedExportId);
  const savedSettings = [];
  const store = {
    async getSetting(key) {
      return settings.get(key) ?? '';
    },
    async saveSetting(key, value) {
      savedSettings.push([key, value]);
      settings.set(key, value);
    },
    registerProjectWork() {
      return () => {};
    },
    async assertProjectExists() {},
  };
  const native = {
    __esModule: true,
    default: mediaState.media,
  };
  const reactNative = {
    ActivityIndicator,
    Alert: {
      alert(title, message, buttons) {
        alerts.push({ title, message, buttons: buttons ?? [] });
      },
    },
    Pressable,
    Switch,
    Text,
    View,
  };
  const mocks = {
    react: reactRuntime,
    'react/jsx-runtime': jsxRuntime,
    'react-native': reactNative,
    '../../../modules/one-take-media': native,
    '@/lib/store': store,
    '@/lib/export-plan': actualExportPlan,
  };
  const componentModule = loadTranspiledModule('src/components/review/export-controls.tsx', mocks);
  const captionSettingsModule = loadTranspiledModule('src/components/review/caption-settings.tsx', mocks);
  return { alerts, component: componentModule.ExportControls, captionSettings: captionSettingsModule.CaptionSettings, savedSettings, calls: mediaState.calls };
}

function renderExport(environment, overrides = {}) {
  const props = {
    project: makeProject(),
    start: 0,
    end: 4,
    timelinePlan: makePlan(),
    ...overrides,
  };
  return new HookRenderer(environment.component, props);
}

function alertButton(environment, label) {
  const alert = environment.alerts.at(-1);
  assert.ok(alert, `expected an alert containing ${label}`);
  const button = alert.buttons.find(candidate => candidate.text === label);
  assert.ok(button, `expected alert button ${label}`);
  return button;
}

async function withNoopTimers(callback) {
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  let nextId = 0;
  globalThis.setTimeout = () => ({ __testTimer: ++nextId });
  globalThis.clearTimeout = () => {};
  try {
    return await callback();
  } finally {
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
  }
}

test('an empty selected timeline disables export before native dispatch', async () => {
  const mediaState = makeMedia();
  const environment = makeEnvironment(mediaState);
  const renderer = renderExport(environment, { timelinePlan: null });
  await renderer.flush();

  const button = findByAccessibilityLabel(renderer.output, 'Export video');
  assert.ok(button);
  assert.equal(button.props.disabled, true);
  assert.equal(mediaState.calls.startExport.length, 0);
  assert.equal(environment.alerts.length, 0);
  renderer.unmount();
});

test('captionless export skips refinement and estimate alerts and sends no captions', async () => {
  const mediaState = makeMedia();
  const environment = makeEnvironment(mediaState);
  const project = makeProject({ refinement: { status: 'running', model: 'tiny' } });
  const renderer = renderExport(environment, {
    project,
    timelinePlan: makePlan({ burnIntoExport: false, hasEstimatedCaptions: false }),
  });
  await renderer.flush();

  const button = findByAccessibilityLabel(renderer.output, 'Export video');
  assert.ok(button);
  assert.equal(button.props.disabled, false);
  button.props.onPress();
  await renderer.flush();

  assert.equal(environment.alerts.length, 0);
  assert.equal(mediaState.calls.startExport.length, 1);
  assert.deepEqual(mediaState.calls.startExport[0].captions, []);
  renderer.unmount();
});

test('export request keeps the selected timeline frozen while the confirmation dialog is open', async () => {
  const mediaState = makeMedia();
  const environment = makeEnvironment(mediaState);
  const selectedPlan = makePlan({
    timelineRevision: 17,
    hasEstimatedCaptions: true,
    segments: [{ uri: 'file:///source.mp4', t0: 0, t1: 4, captions: [{ t0: 0, t1: 1, text: 'selected' }] }],
  });
  const renderer = renderExport(environment, { timelinePlan: selectedPlan });
  await renderer.flush();

  findByAccessibilityLabel(renderer.output, 'Export video').props.onPress();
  assert.equal(environment.alerts.length, 1);
  assert.equal(environment.alerts[0].title, 'Live caption timing is approximate');

  selectedPlan.timelineRevision = 99;
  selectedPlan.segments[0].t0 = 2;
  selectedPlan.segments[0].t1 = 3;
  renderer.update({
    project: makeProject(),
    start: 0,
    end: 4,
    timelinePlan: makePlan({ timelineRevision: 99, segments: [{ uri: 'file:///source.mp4', t0: 2, t1: 3, captions: [] }] }),
  });
  await renderer.flush();

  alertButton(environment, 'Use selected captions').onPress();
  await renderer.flush();
  assert.equal(mediaState.calls.startExport.length, 1);
  assert.equal(mediaState.calls.startExport[0].timelineRevision, 17);
  assert.equal(mediaState.calls.startExport[0].segments[0].t0, 0);
  assert.equal(mediaState.calls.startExport[0].segments[0].t1, 4);
  assert.equal(mediaState.calls.startExport[0].segments[0].captions[0].text, 'selected');
  renderer.unmount();
});

test('a complete displayed proposal can export without a cutsReviewed gate', async () => {
  const mediaState = makeMedia();
  const environment = makeEnvironment(mediaState);
  const renderer = renderExport(environment, {
    project: makeProject({ cutsReviewed: false, reviewSegments: [{ uri: 'file:///source.mp4', t0: 0, t1: 4 }] }),
    timelinePlan: makePlan({ burnIntoExport: false }),
  });
  await renderer.flush();

  assert.doesNotMatch(textContent(renderer.output), /Review and accept each cut/);
  const button = findByAccessibilityLabel(renderer.output, 'Export video');
  assert.ok(button);
  assert.equal(button.props.disabled, false);
  button.props.onPress();
  await renderer.flush();
  assert.equal(mediaState.calls.startExport.length, 1);
  assert.equal(environment.alerts.length, 0);
  renderer.unmount();
});

test('a completed export keeps open, gallery, and share actions available', async () => {
  const mediaState = makeMedia({ savedExportId: 'restored' });
  const environment = makeEnvironment(mediaState);
  const renderer = renderExport(environment);
  await renderer.flush();

  const open = findByAccessibilityLabel(renderer.output, 'Open exported video');
  const save = findByAccessibilityLabel(renderer.output, 'Save exported video to gallery');
  const share = findByAccessibilityLabel(renderer.output, 'Share exported video');
  assert.ok(open);
  assert.ok(save);
  assert.ok(share);
  open.props.onPress();
  await renderer.flush();
  save.props.onPress();
  await renderer.flush();
  share.props.onPress();
  await renderer.flush();
  assert.deepEqual(mediaState.calls.openExport, ['restored']);
  assert.deepEqual(mediaState.calls.saveToGallery, ['restored']);
  assert.deepEqual(mediaState.calls.shareExport, ['restored']);
  renderer.unmount();
});

test('a running export exposes cancel and then preserves retry behavior', async () => {
  await withNoopTimers(async () => {
    let cancelled = false;
    const mediaState = makeMedia({
      savedExportId: 'active',
      getExport(id) {
        if (id === 'active') return { id, status: cancelled ? 'cancelled' : 'running', progress: 0.4 };
        return { id, status: 'completed', progress: 1, uri: `file:///${id}.mp4` };
      },
    });
    const originalCancel = mediaState.media.cancelExport;
    mediaState.media.cancelExport = async id => {
      await originalCancel(id);
      cancelled = true;
    };
    const environment = makeEnvironment(mediaState);
    const renderer = renderExport(environment);
    await renderer.flush();

    const cancel = findByAccessibilityLabel(renderer.output, 'Cancel video export');
    assert.ok(cancel);
    cancel.props.onPress();
    await renderer.flush();
    assert.deepEqual(mediaState.calls.cancelExport, ['active']);

    const retry = findByAccessibilityLabel(renderer.output, 'Retry video export');
    assert.ok(retry);
    assert.equal(retry.props.disabled, false);
    retry.props.onPress();
    await renderer.flush();
    assert.equal(mediaState.calls.startExport.length, 1);
    assert.equal(mediaState.calls.getExport.at(-1), mediaState.calls.startExport[0].id);
    renderer.unmount();
  });
});

test('caption settings dispatches editor and export choices through independent callbacks', () => {
  const mediaState = makeMedia();
  const environment = makeEnvironment(mediaState);
  const changes = [];
  const output = environment.captionSettings({
    showInEditor: false,
    burnIntoExport: true,
    onShowInEditorChange: value => changes.push(['editor', value]),
    onBurnIntoExportChange: value => changes.push(['export', value]),
  });
  const editor = findByAccessibilityLabel(output, 'Show captions in editor');
  const exportChoice = findByAccessibilityLabel(output, 'Burn captions into export');
  assert.ok(editor);
  assert.ok(exportChoice);
  assert.equal(editor.props.value, false);
  assert.equal(exportChoice.props.value, true);
  editor.props.onValueChange(true);
  exportChoice.props.onValueChange(false);
  assert.deepEqual(changes, [['editor', true], ['export', false]]);
});

test('confirmation from a previous project cannot start after navigation', async () => {
  const mediaState = makeMedia();
  const environment = makeEnvironment(mediaState);
  const renderer = renderExport(environment, { timelinePlan: makePlan({ hasEstimatedCaptions: true }) });
  await renderer.flush();
  findByAccessibilityLabel(renderer.output, 'Export video').props.onPress();
  const confirm = alertButton(environment, 'Use selected captions');
  renderer.update({ project: makeProject({ id: 'other-project' }), start: 0, end: 4, timelinePlan: makePlan() });
  await renderer.flush();
  confirm.onPress();
  await renderer.flush();
  assert.equal(mediaState.calls.startExport.length, 0);
  renderer.unmount();
});

test('missing completed output offers retry instead of gallery/share actions', async () => {
  const mediaState = makeMedia({ savedExportId: 'missing-output', getExport: id => ({
    id, status: 'failed', progress: 100, error: 'Export output is missing. Retry to create it again.',
  }) });
  const environment = makeEnvironment(mediaState);
  const renderer = renderExport(environment);
  await renderer.flush();
  assert.equal(findByAccessibilityLabel(renderer.output, 'Share exported video'), null);
  assert.equal(findByAccessibilityLabel(renderer.output, 'Save exported video to gallery'), null);
  const retry = findByAccessibilityLabel(renderer.output, 'Retry video export');
  assert.equal(retry.props.disabled, false);
  retry.props.onPress();
  await renderer.flush();
  assert.equal(mediaState.calls.startExport.length, 1);
  renderer.unmount();
});
