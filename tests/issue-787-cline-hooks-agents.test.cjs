// allow-test-rule: source-text-is-the-product
// The Cline rules markdown, the PreToolUse hook script, and the AGENTS.md block
// ARE the deployed contract that the Cline runtime loads/executes — testing their
// text/behavior tests the shipped artifact. Per CONTRIBUTING.md exception matrix.

/**
 * Issue #787 — elevate Cline: write hooks + AGENTS.md.
 *
 * Verifies the installer emits the Cline rules file (`<configDir>/rules/gsd.md`),
 * a PreToolUse lifecycle hook (`<configDir>/hooks/PreToolUse`, Cline JSON
 * stdin → {cancel,errorMessage,contextModification} protocol), and a global
 * ~/.agents/AGENTS.md instruction target. The legacy `.clinerules/` layout is
 * deprecated by Cline and cleaned up on install.
 *
 * Primary sources adjudicated:
 *  - https://docs.cline.bot/features/hooks
 *      hooks live at .cline/hooks/<EventName> (project) and ~/.cline/hooks/
 *      (global); executable scripts named exactly after the event with no
 *      extension; JSON stdin → JSON stdout with cancel / errorMessage /
 *      contextModification; payload nests the call under `preToolUse`.
 *  - https://docs.cline.bot/customization/cline-rules
 *      Cline reads rules from .cline/rules/ (and the deprecated .clinerules/)
 *      plus cross-tool global instructions from ~/.agents/AGENTS.md.
 */

'use strict';

process.env.GSD_TEST_MODE = '1';

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const { createTempDir, cleanup } = require('./helpers.cjs');

const INSTALL_SCRIPT = path.join(__dirname, '..', 'bin', 'install.js');

const {
  install,
  uninstall,
  buildClineRulesBody,
  buildClinePreToolUseHook,
  buildClineAgentsMdBody,
  mergeGsdAgentsMd,
  stripGsdFromAgentsMd,
  GSD_AGENTS_MD_MARKER,
  GSD_AGENTS_MD_CLOSE_MARKER,
} = require('../bin/install.js');

// ─── Pure helpers ─────────────────────────────────────────────────────────────

describe('#787 Cline pure helpers', () => {
  test('buildClineRulesBody returns GSD rules markdown with the engine prefix', () => {
    const body = buildClineRulesBody();
    assert.equal(typeof body, 'string');
    assert.match(body, /GSD workflows live in `\.cline\/gsd-core\/workflows\/`/);
    assert.match(buildClineRulesBody('~/.cline/'), /GSD workflows live in `~\/\.cline\/gsd-core\/workflows\/`/);
    assert.ok(body.endsWith('\n'), 'rules body should end with a trailing newline');
  });

  test('buildClinePreToolUseHook returns a syntactically valid Node script', () => {
    const script = buildClinePreToolUseHook();
    assert.match(script, /^#!\/usr\/bin\/env node/, 'must carry a node shebang');
    // Cline protocol fields must be present in the emitted decision surface.
    assert.match(script, /cancel/);
    assert.match(script, /errorMessage/);
    const tmp = createTempDir('gsd-787-hookcheck-');
    try {
      const p = path.join(tmp, 'PreToolUse');
      fs.writeFileSync(p, script);
      const res = spawnSync(process.execPath, ['--check', p], { encoding: 'utf8' });
      assert.equal(res.status, 0, `node --check failed: ${res.stderr}`);
    } finally {
      cleanup(tmp);
    }
  });

  test('PreToolUse hook allows a normal tool call (cancel:false)', () => {
    const tmp = createTempDir('gsd-787-hookrun-');
    try {
      const p = path.join(tmp, 'PreToolUse');
      fs.writeFileSync(p, buildClinePreToolUseHook());
      const res = spawnSync(process.execPath, [p], {
        input: JSON.stringify({ toolName: 'read_file', toolInput: { path: 'src/index.ts' } }),
        encoding: 'utf8',
      });
      assert.equal(res.status, 0);
      const out = JSON.parse(res.stdout);
      assert.equal(out.cancel, false);
    } finally {
      cleanup(tmp);
    }
  });

  test('PreToolUse hook cancels a write into .planning/ with an errorMessage', () => {
    const tmp = createTempDir('gsd-787-hookguard-');
    try {
      const p = path.join(tmp, 'PreToolUse');
      fs.writeFileSync(p, buildClinePreToolUseHook());
      const res = spawnSync(process.execPath, [p], {
        input: JSON.stringify({ toolName: 'write_to_file', toolInput: { path: '.planning/ROADMAP.md', content: 'x' } }),
        encoding: 'utf8',
      });
      assert.equal(res.status, 0);
      const out = JSON.parse(res.stdout);
      assert.equal(out.cancel, true);
      assert.match(out.errorMessage, /\.planning/);
    } finally {
      cleanup(tmp);
    }
  });

  test('PreToolUse hook does NOT cancel a write to a non-planning path whose CONTENT mentions .planning/', () => {
    const tmp = createTempDir('gsd-787-hookfp-');
    try {
      const p = path.join(tmp, 'PreToolUse');
      fs.writeFileSync(p, buildClinePreToolUseHook());
      const res = spawnSync(process.execPath, [p], {
        input: JSON.stringify({
          toolName: 'write_to_file',
          toolInput: { path: 'docs/guide.md', content: 'Edit your .planning/ROADMAP.md via /gsd commands.' },
        }),
        encoding: 'utf8',
      });
      assert.equal(res.status, 0);
      assert.equal(JSON.parse(res.stdout).cancel, false, 'content mentioning .planning must not trigger a cancel');
    } finally {
      cleanup(tmp);
    }
  });

  test('PreToolUse hook fails open on malformed stdin', () => {
    const tmp = createTempDir('gsd-787-hookbad-');
    try {
      const p = path.join(tmp, 'PreToolUse');
      fs.writeFileSync(p, buildClinePreToolUseHook());
      const res = spawnSync(process.execPath, [p], { input: 'not json{', encoding: 'utf8' });
      assert.equal(res.status, 0);
      assert.equal(JSON.parse(res.stdout).cancel, false);
    } finally {
      cleanup(tmp);
    }
  });

  // Regression: the hook originally parsed only flattened Claude-style fields
  // (toolName/toolInput), while Cline's documented payload nests the call under
  // `preToolUse` — the guard silently never fired against real Cline input.
  // Payload shape per https://docs.cline.bot/features/hooks and cline/cline
  // apps/vscode/src/core/hooks/hook-factory.ts.
  test('PreToolUse hook cancels a .planning/ write with the real Cline nested payload', () => {
    const tmp = createTempDir('gsd-787-hookcline-');
    try {
      const p = path.join(tmp, 'PreToolUse');
      fs.writeFileSync(p, buildClinePreToolUseHook());
      const res = spawnSync(process.execPath, [p], {
        input: JSON.stringify({
          taskId: 't1',
          clineVersion: '3.48.0',
          timestamp: 1736654400000,
          workspacePath: '/repo',
          preToolUse: { tool: 'write_to_file', parameters: { path: '.planning/ROADMAP.md', content: 'x' } },
        }),
        encoding: 'utf8',
      });
      assert.equal(res.status, 0);
      const out = JSON.parse(res.stdout);
      assert.equal(out.cancel, true, 'nested preToolUse payload must be intercepted');
      assert.match(out.errorMessage, /\.planning/);
    } finally {
      cleanup(tmp);
    }
  });

  test('PreToolUse hook allows ordinary writes/reads with the real Cline nested payload', () => {
    const tmp = createTempDir('gsd-787-hookcline-allow-');
    try {
      const p = path.join(tmp, 'PreToolUse');
      fs.writeFileSync(p, buildClinePreToolUseHook());
      const write = spawnSync(process.execPath, [p], {
        input: JSON.stringify({
          taskId: 't1',
          preToolUse: { tool: 'write_to_file', parameters: { path: 'src/index.ts', content: 'x' } },
        }),
        encoding: 'utf8',
      });
      assert.equal(JSON.parse(write.stdout).cancel, false, 'ordinary write must pass');
      const read = spawnSync(process.execPath, [p], {
        input: JSON.stringify({
          taskId: 't1',
          preToolUse: { tool: 'read_file', parameters: { path: '.planning/ROADMAP.md' } },
        }),
        encoding: 'utf8',
      });
      assert.equal(JSON.parse(read.stdout).cancel, false, 'read of .planning/ must pass');
    } finally {
      cleanup(tmp);
    }
  });

  test('mergeGsdAgentsMd creates a marker-delimited block when no file exists', () => {
    const tmp = createTempDir('gsd-787-agents-new-');
    try {
      const p = path.join(tmp, 'AGENTS.md');
      mergeGsdAgentsMd(p, buildClineAgentsMdBody());
      const content = fs.readFileSync(p, 'utf8');
      assert.ok(content.includes(GSD_AGENTS_MD_MARKER));
      assert.ok(content.includes(GSD_AGENTS_MD_CLOSE_MARKER));
      assert.match(content, /GSD/);
    } finally {
      cleanup(tmp);
    }
  });

  test('mergeGsdAgentsMd preserves pre-existing user content', () => {
    const tmp = createTempDir('gsd-787-agents-merge-');
    try {
      const p = path.join(tmp, 'AGENTS.md');
      fs.writeFileSync(p, '# My rules\n\nKeep me.\n');
      mergeGsdAgentsMd(p, buildClineAgentsMdBody());
      const content = fs.readFileSync(p, 'utf8');
      assert.match(content, /Keep me\./);
      assert.ok(content.includes(GSD_AGENTS_MD_MARKER));
      // Idempotent: second merge does not duplicate the block.
      mergeGsdAgentsMd(p, buildClineAgentsMdBody());
      const twice = fs.readFileSync(p, 'utf8');
      const occurrences = twice.split(GSD_AGENTS_MD_MARKER).length - 1;
      assert.equal(occurrences, 1, 'GSD block must not duplicate on re-merge');
      assert.match(twice, /Keep me\./);
    } finally {
      cleanup(tmp);
    }
  });

  test('stripGsdFromAgentsMd returns null when file was GSD-only, else cleaned content', () => {
    const onlyGsd = `${GSD_AGENTS_MD_MARKER}\nhi\n${GSD_AGENTS_MD_CLOSE_MARKER}\n`;
    assert.equal(stripGsdFromAgentsMd(onlyGsd), null);
    const mixed = `# Keep\n\n${GSD_AGENTS_MD_MARKER}\nhi\n${GSD_AGENTS_MD_CLOSE_MARKER}\n`;
    const cleaned = stripGsdFromAgentsMd(mixed);
    assert.match(cleaned, /# Keep/);
    assert.ok(!cleaned.includes(GSD_AGENTS_MD_MARKER));
  });
});

// ─── Local install: rules + hook under .cline/ ──────────────────────────────────

describe('#787 Cline local install — .cline/ layout + PreToolUse hook', () => {
  let tmpDir;
  let previousCwd;

  beforeEach(() => {
    tmpDir = createTempDir('gsd-787-cline-local-');
    previousCwd = process.cwd();
    process.chdir(tmpDir);
  });

  afterEach(() => {
    process.chdir(previousCwd);
    cleanup(tmpDir);
  });

  test('writes rules/gsd.md and hooks/PreToolUse under .cline/', () => {
    install(false, 'cline');
    const ruleFile = path.join(tmpDir, '.cline', 'rules', 'gsd.md');
    assert.ok(fs.existsSync(ruleFile), '.cline/rules/gsd.md must exist');
    assert.match(fs.readFileSync(ruleFile, 'utf8'), /\.cline\/gsd-core\/workflows\//);
  });

  test('keeps the gsd-core engine and agents under .cline/, not the project root', () => {
    install(false, 'cline');
    assert.ok(fs.existsSync(path.join(tmpDir, '.cline', 'gsd-core', 'workflows')), 'engine must live under .cline/');
    assert.ok(fs.existsSync(path.join(tmpDir, '.cline', 'agents')), 'agents must live under .cline/');
    assert.ok(!fs.existsSync(path.join(tmpDir, 'gsd-core')), 'project root must not get a gsd-core/ directory');
    assert.ok(!fs.existsSync(path.join(tmpDir, 'agents')), 'project root must not get an agents/ directory');
    assert.ok(!fs.existsSync(path.join(tmpDir, 'scripts')), 'project root must not get a scripts/ directory');
    assert.ok(!fs.existsSync(path.join(tmpDir, 'gsd-file-manifest.json')), 'manifest must not sit at the project root');
  });

  test('writes an executable PreToolUse hook with no extension', () => {
    install(false, 'cline');
    const hook = path.join(tmpDir, '.cline', 'hooks', 'PreToolUse');
    assert.ok(fs.existsSync(hook), '.cline/hooks/PreToolUse must exist');
    if (process.platform !== 'win32') {
      const mode = fs.statSync(hook).mode;
      assert.ok((mode & 0o111) !== 0, 'PreToolUse must be executable');
    }
  });

  test('leaves a user-owned single-file .clinerules untouched', () => {
    // Simulate a user who maintains their own legacy .clinerules FILE.
    fs.writeFileSync(path.join(tmpDir, '.clinerules'), '# my own rules\n');
    install(false, 'cline');
    assert.equal(fs.readFileSync(path.join(tmpDir, '.clinerules'), 'utf8'), '# my own rules\n');
    assert.ok(fs.existsSync(path.join(tmpDir, '.cline', 'rules', 'gsd.md')));
  });

  test('removes GSD-managed files from a legacy .clinerules/ dir but keeps user files', () => {
    // Simulate a pre-fix install: GSD artifacts + a user's own rule file.
    const dir = path.join(tmpDir, '.clinerules');
    fs.mkdirSync(path.join(dir, 'hooks'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'gsd.md'), buildClineRulesBody());
    fs.writeFileSync(path.join(dir, 'hooks', 'PreToolUse'), buildClinePreToolUseHook());
    fs.writeFileSync(path.join(dir, 'mine.md'), '# user rule\n');
    install(false, 'cline');
    assert.ok(!fs.existsSync(path.join(dir, 'gsd.md')), 'GSD gsd.md must be removed');
    assert.ok(!fs.existsSync(path.join(dir, 'hooks', 'PreToolUse')), 'GSD hook must be removed');
    assert.ok(fs.existsSync(path.join(dir, 'mine.md')), 'user rule file must be preserved');
  });

  test('does not follow a symlinked .clinerules', () => {
    if (process.platform === 'win32') return; // symlink perms differ on Windows
    const external = path.join(tmpDir, 'external-target');
    fs.mkdirSync(external);
    fs.symlinkSync(external, path.join(tmpDir, '.clinerules'));
    install(false, 'cline');
    assert.ok(fs.lstatSync(path.join(tmpDir, '.clinerules')).isSymbolicLink(), 'symlink must be left in place');
    assert.ok(!fs.existsSync(path.join(external, 'gsd.md')), 'must not write through the symlink target');
    assert.ok(fs.existsSync(path.join(tmpDir, '.cline', 'rules', 'gsd.md')));
  });

  test('removes the pre-fix root-level spill using the old manifest hashes', () => {
    // Simulate the old layout: engine/agents/state dumped at the project root,
    // tracked by a root-level manifest with sha256 hashes.
    const crypto = require('node:crypto');
    const hashFile = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
    fs.mkdirSync(path.join(tmpDir, 'gsd-core', 'workflows'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'gsd-core', 'VERSION'), '1.9.0\n');
    fs.mkdirSync(path.join(tmpDir, 'agents'));
    fs.writeFileSync(path.join(tmpDir, 'agents', 'gsd-planner.md'), '# planner\n');
    // 用户改过的文件必须保留
    fs.writeFileSync(path.join(tmpDir, 'agents', 'gsd-executor.md'), '# user edited\n');
    const manifest = {
      version: '1.9.0',
      files: {
        'gsd-core/VERSION': hashFile(path.join(tmpDir, 'gsd-core', 'VERSION')),
        'agents/gsd-planner.md': hashFile(path.join(tmpDir, 'agents', 'gsd-planner.md')),
        'agents/gsd-executor.md': 'deadbeef'.repeat(8),
        '.clinerules/gsd.md': 'deadbeef'.repeat(8),
      },
    };
    fs.writeFileSync(path.join(tmpDir, 'gsd-file-manifest.json'), JSON.stringify(manifest));
    fs.writeFileSync(path.join(tmpDir, 'gsd-install-state.json'), '{}');
    fs.writeFileSync(path.join(tmpDir, '.gsd-profile'), 'full');
    install(false, 'cline');
    assert.ok(!fs.existsSync(path.join(tmpDir, 'gsd-core')), 'hash-matched gsd-core/ must be removed');
    assert.ok(!fs.existsSync(path.join(tmpDir, 'agents', 'gsd-planner.md')), 'hash-matched file must be removed');
    assert.ok(fs.existsSync(path.join(tmpDir, 'agents', 'gsd-executor.md')), 'user-modified file must be kept');
    assert.ok(!fs.existsSync(path.join(tmpDir, 'gsd-file-manifest.json')), 'root manifest must be removed');
    assert.ok(!fs.existsSync(path.join(tmpDir, 'gsd-install-state.json')), 'root state must be removed');
    assert.ok(!fs.existsSync(path.join(tmpDir, '.gsd-profile')), 'root profile marker must be removed');
    assert.ok(fs.existsSync(path.join(tmpDir, '.cline', 'rules', 'gsd.md')), 'new layout must be installed');
  });

  test('manifest tracks the new-layout artifacts under .cline/', () => {
    install(false, 'cline');
    const manifestPath = path.join(tmpDir, '.cline', 'gsd-file-manifest.json');
    assert.ok(fs.existsSync(manifestPath));
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    assert.ok(manifest.files['rules/gsd.md'], 'manifest should track rules/gsd.md');
    assert.ok(manifest.files['hooks/PreToolUse'], 'manifest should track the hook');
  });
});

// ─── Global install: ~/.agents/AGENTS.md (subprocess, HOME-isolated) ─────────────

describe('#787 Cline global install — ~/.agents/AGENTS.md', () => {
  function runGlobalClineInstall() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-787-cline-global-'));
    const env = { ...process.env, HOME: root, USERPROFILE: root };
    delete env.GSD_TEST_MODE;
    const res = spawnSync(
      process.execPath,
      [INSTALL_SCRIPT, '--cline', '--global', '--config-dir', path.join(root, '.cline')],
      { cwd: root, encoding: 'utf8', env },
    );
    return { root, res };
  }

  test('writes ~/.agents/AGENTS.md with a GSD marker block', () => {
    const { root, res } = runGlobalClineInstall();
    try {
      assert.equal(res.status, 0, `installer failed: ${res.stderr}`);
      const agents = path.join(root, '.agents', 'AGENTS.md');
      assert.ok(fs.existsSync(agents), '~/.agents/AGENTS.md must exist after a global Cline install');
      const content = fs.readFileSync(agents, 'utf8');
      assert.ok(content.includes(GSD_AGENTS_MD_MARKER));
      assert.match(content, /GSD/);
    } finally {
      cleanup(root);
    }
  });
});

// ─── Uninstall symmetry ─────────────────────────────────────────────────────────

describe('#787 Cline uninstall removes managed artifacts', () => {
  let tmpDir;
  let previousCwd;

  beforeEach(() => {
    tmpDir = createTempDir('gsd-787-cline-uninstall-');
    previousCwd = process.cwd();
    process.chdir(tmpDir);
  });

  afterEach(() => {
    process.chdir(previousCwd);
    cleanup(tmpDir);
  });

  test('local uninstall removes .cline/rules/gsd.md and the hook', () => {
    install(false, 'cline');
    assert.ok(fs.existsSync(path.join(tmpDir, '.cline', 'rules', 'gsd.md')));
    uninstall(false, 'cline');
    assert.ok(!fs.existsSync(path.join(tmpDir, '.cline', 'rules', 'gsd.md')), 'gsd.md should be removed');
    assert.ok(!fs.existsSync(path.join(tmpDir, '.cline', 'hooks', 'PreToolUse')), 'hook should be removed');
  });
});
