import path from 'path';
import { promises as fs, existsSync, Dirent } from 'fs';
import { ChildProcess, execSync, spawn, SpawnOptions } from 'child_process';

import gulp from 'gulp';
import gulpSm from 'gulp-sourcemaps';
import gulpTs from 'gulp-typescript';
import { EventEmitter } from 'events';

const PathTo = {
  Source: __dirname,
  Built: path.resolve('.', '.built'),
  Bundled: path.resolve('.', '.bundled'),
  Jest: path.resolve('.', '.jest'),
};
const KeyTo = {
  BuiltRoots: 'builtRoots',
  SourceRoots: 'sourceRoots',
  Bundles: 'bundles',
};
const spawnOpts: SpawnOptions = {
  shell: true,
  cwd: __dirname,
  stdio: ['ignore', 'pipe', 'pipe'],
};
const Tools = {
  Tfx: which('tfx'),
  Yarn: which('yarn'),
  Jest: which('jest'),
};

// These control that arch and platform of the target system for yarn dependency installation
const yarnArgs = ['--target_arch=x64', '--target_platform=linux'];

const memCache: { [key: string]: any } = {};
async function withCache<T = any>(key: string, factory: () => Promise<T>): Promise<T> {
  memCache[key] = memCache[key] || (await factory());
  return memCache[key];
}

async function withMany<TIn = any, TOut = any>(sources: TIn[], handler: (source: TIn) => Promise<TOut> | EventEmitter) {
  const results = await Promise.all(
    sources.map((source) => {
      const result = handler(source);
      if (result instanceof EventEmitter) {
        return new Promise((resolve, reject) => {
          result
            .on('error', (...args: any[]) => {
              reject(...args);
            })
            .on('end', (...args: any[]) => {
              resolve(...args);
            });
        });
      }
      return result;
    })
  );
  return results;
}

function which(tool: string) {
  const toolPath = execSync(`which ${tool}`).toString().trim();
  return toolPath;
}

function waitForProcess(childProcess: ChildProcess) {
  return new Promise<ChildProcessResult>((resolve, reject) => {
    const stdoutChunks: any[] = [];
    const stderrChunks: any[] = [];
    if (childProcess.stdout) childProcess.stdout.on('data', (chunk) => stdoutChunks.push(chunk));
    if (childProcess.stderr) childProcess.stderr.on('data', (chunk) => stderrChunks.push(chunk));
    childProcess.once('exit', (code: number) => {
      if (code === 0) {
        resolve({
          code,
          stdout: stdoutChunks.join('\n').trim(),
          stderr: stderrChunks.join('\n').trim(),
        });
      } else {
        reject({
          code,
          stdout: stdoutChunks.join('\n').trim(),
          stderr: stderrChunks.join('\n').trim(),
        });
      }
    });
    childProcess.once('error', (err: any) => {
      reject(err);
    });
  });
}

function printOutput(tag: string, output: string) {
  console.log(
    `${tag}:\n${output
      .split('\n')
      .filter((l) => l.length > 0)
      .map((l) => `\t${l}`)
      .join('\n')}\n`
  );
}

async function getAllRootsFrom(base: string, filter?: (value: Dirent, index: number, array: Dirent[]) => boolean) {
  const entries = await fs.readdir(base, { withFileTypes: true });
  return entries.filter((v, i, a) => (!!filter ? filter(v, i, a) : true)).map((ent) => path.resolve(base, ent.name));
}

async function getAllSourceRoots() {
  return withCache(KeyTo.SourceRoots, () =>
    getAllRootsFrom(
      PathTo.Source,
      (ent) =>
        ent.isDirectory() &&
        existsSync(path.join(ent.name, 'vss-extension.json')) &&
        existsSync(path.join(ent.name, 'task.json'))
    )
  );
}

async function getAllBuiltRoots() {
  return withCache(KeyTo.BuiltRoots, () =>
    getAllRootsFrom(
      PathTo.Built,
      (ent) =>
        ent.isDirectory() &&
        existsSync(path.join(ent.name, 'vss-extension.json')) &&
        existsSync(path.join(ent.name, 'task.json'))
    )
  );
}

async function getAllBundles() {
  return withCache(KeyTo.Bundles, async () => {
    const files = await fs.readdir(PathTo.Bundled);
    return files.filter((f) => f.endsWith('vsix')).map((f) => path.join(PathTo.Bundled, f));
  });
}

async function readJson<T = any>(fromFile: string) {
  return JSON.parse((await fs.readFile(fromFile)).toString()) as T;
}

async function writeJson<T = any>(data: T, toFile: string) {
  await fs.writeFile(toFile, JSON.stringify(data, undefined, 2));
}

async function updateExtensions(...folders: string[]) {
  await withMany(folders, async (folder) => {
    const taskFilePath = path.join(folder, 'task.json');
    const packageFilePath = path.join(folder, 'package.json');
    const manifestFilePath = path.join(folder, 'vss-extension.json');

    const [_task, _package, _manifest] = await Promise.all([
      readJson<VssTask>(taskFilePath),
      readJson<NpmPackage>(packageFilePath),
      readJson<VssManifest>(manifestFilePath),
    ]);

    _task.version.Patch = _task.version.Patch + 1;
    _task.execution = {
      Node10: {
        target: _package.main,
      },
    };

    _manifest.id = _package.name;
    _manifest.name = _package.name
      .split('-')
      .map((s) => `${s[0].toUpperCase()}${s.slice(1)}`)
      .join(' ');
    _manifest.description = _package.description;
    _manifest.files = [{ path: 'task' }];
    _manifest.contributions = [
      {
        id: _manifest.id,
        type: 'ms.vss-distributed-task.task',
        targets: ['ms.vss-distributed-task.tasks'],
        properties: { name: 'task' },
      },
    ];
    _manifest.version = _manifest.version
      .split('.')
      .map((v, i) => (i === 2 ? parseInt(v) + 1 : v)) // Only increment the patch segment
      .join('.');

    await Promise.all([writeJson(_task, taskFilePath), writeJson(_manifest, manifestFilePath)]);
  });
}

async function compileExtensions(...folders: string[]): Promise<void> {
  await withMany(folders, (folder) => {
    const tsProj = gulpTs.createProject(path.join(folder, 'tsconfig.json'));
    const includes = [`${folder}/**/*.ts`, `${folder}/**/*.d.ts`, `./*.d.ts`];
    const excludes = [`!${folder}/tests/**/*`];
    const reporter = gulpTs.reporter.fullReporter();
    return gulp
      .src([...includes, ...excludes])
      .pipe(gulpSm.init())
      .pipe(tsProj(reporter))
      .pipe(gulpSm.write())
      .pipe(gulp.dest(path.join(PathTo.Built, path.basename(folder), 'task')));
  });
}

async function copyExtensionAssets(...folders: string[]) {
  await withMany(folders, async (folder) => {
    const stageFolder = path.join(PathTo.Built, path.basename(folder));
    const includes = ['json', 'png'].map((ext) => `${folder}/**/*.${ext}`);
    const excludes = [
      `!${folder}/node_modules/**/*`,
      `!${folder}/(tsconfig|vss-extension).json`,
      `!${folder}/tests/**/*`,
    ];
    const _manifest = await readJson<VssManifest>(path.join(folder, 'vss-extension.json'));
    const iconPath = path.basename(_manifest.icons.default);
    await fs.copyFile(path.join(folder, 'vss-extension.json'), path.join(stageFolder, 'vss-extension.json'));
    await fs.copyFile(path.join(folder, iconPath), path.join(stageFolder, iconPath));
    return gulp.src([...includes, ...excludes]).pipe(gulp.dest(path.join(stageFolder, 'task')));
  });
}

async function installExtensionDeps(...folders: string[]) {
  await withMany(folders, async (folder) => {
    const args = [
      '--cwd',
      `${folder}/task`,
      'install',
      '--production',
      '--no-lockfile',
      '--silent',
      '--non-interactive',
      ...yarnArgs,
    ];
    return await waitForProcess(spawn(Tools.Yarn, args, { ...spawnOpts }));
  });
}

async function testExtensions(...folders: string[]) {
  const args: string[] = [];
  const userArgs = process.argv.slice(3).map((a) => (a.includes(' ') ? `"${a}"` : a));
  await waitForProcess(
    spawn(Tools.Jest, [...args, ...userArgs], { ...spawnOpts, stdio: ['ignore', 'inherit', 'inherit'] })
  );
}

async function makeExtensionBuildFolders(...folders: string[]) {
  await withMany(folders, async (folder) => {
    await fs.mkdir(path.join(PathTo.Built, path.basename(folder)), { recursive: true });
  });
}

async function bundleExtensions(...folders: string[]) {
  await withMany(folders, async (folder) => {
    const args = [
      'extension',
      'create',
      '--no-color',
      '--no-prompt',
      '--manifest-globs',
      'vss-extension.json',
      '--root',
      folder,
      '--output-path',
      PathTo.Bundled,
    ];
    const result = await waitForProcess(spawn(Tools.Tfx, args, { ...spawnOpts, cwd: folder }));
    printOutput(path.basename(folder), result.stdout);
  });
}

async function publishExtensions(...files: string[]) {
  const token = process.env.TFX_PUBLISH_TOKEN;
  if (!token || token.length < 52) {
    throw new Error(`Cannot publish without a token in TFX_PUBLISH_TOKEN!`);
  }
  await withMany(files, async (file) => {
    const args = [
      'extension',
      'publish',
      '--no-color',
      '--no-prompt',
      '--auth-type',
      'pat',
      '--token',
      token,
      '--vsix',
      file,
    ];
    try {
      const result = await waitForProcess(spawn(Tools.Tfx, args, { ...spawnOpts }));
      printOutput(path.basename(file), result.stdout);
    } catch (error) {
      printOutput(path.basename(file), error.stdout);
    }
  });
}

export async function install() {
  const taskFolders = await getAllSourceRoots();
  await installExtensionDeps(...taskFolders);
}

export async function clean() {
  await fs.rmdir(PathTo.Built, { recursive: true });
  await fs.rmdir(PathTo.Bundled, { recursive: true });
  await fs.rmdir(PathTo.Jest, { recursive: true });
}

export async function build() {
  await fs.rmdir(PathTo.Built, { recursive: true });

  const taskFolders = await getAllSourceRoots();

  await Promise.all([updateExtensions(...taskFolders), makeExtensionBuildFolders(...taskFolders)]);
  await Promise.all([compileExtensions(...taskFolders), copyExtensionAssets(...taskFolders)]);

  const builtFolders = await getAllBuiltRoots();
  await installExtensionDeps(...builtFolders);
}

export async function test() {
  const builtFolders = await getAllSourceRoots();
  const testFolders = builtFolders
    .filter((folder) => existsSync(path.join(folder, 'tests')));
  await testExtensions(...testFolders);
}

export async function bundle() {
  await fs.rmdir(PathTo.Bundled, { recursive: true });
  await fs.mkdir(PathTo.Bundled, { recursive: true });

  const builtFolders = await getAllBuiltRoots();
  await bundleExtensions(...builtFolders);
}

export async function publish() {
  const vsixFiles = await getAllBundles();
  await publishExtensions(...vsixFiles);
}

type ChildProcessResult = { code: number; stdout: string; stderr: string };

type VssTask = {
  version: { Major: number; Minor: number; Patch: number };
  execution: { [key: string]: { [key: string]: string } };
};

type VssManifest = {
  id: string;
  name: string;
  description: string;
  version: string;
  icons: { [key: string]: string };
  files: { path: string }[];
  contributions: {
    id: string;
    type: string;
    targets: string[];
    properties: {
      name: string;
    };
  }[];
};

type NpmPackage = {
  name: string;
  main: string;
  version: string;
  author: string;
  license: string;
  description: string;
};