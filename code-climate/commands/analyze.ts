import fs from 'fs';
import path from 'path';
import { TaskConfig } from '../types';
import { findCodeClimate } from './utils';
import * as tl from 'azure-pipelines-task-lib/task';

export async function analyze(config: TaskConfig) {
  const codeClimate = findCodeClimate();
  if (!codeClimate.exists) {
    return tl.setResult(tl.TaskResult.Failed, 'Code Climate is not installed.', true);
  }

  const outputFile = fs.createWriteStream(config.outputPath, { encoding: 'utf8' });
  const relativeSourcePath = path.relative(config.configFilePath, config.sourcePath);
  const result = tl
    .tool(codeClimate.path)
    .arg('analyze')
    .arg('-f')
    .arg(config.analysisFormat)
    .arg(relativeSourcePath)
    .on('stdout', (data: Buffer) => outputFile.write(data))
    .execSync({
      env: {
        ...process.env,
        CODECLIMATE_CODE: config.configFilePath,
        CODECLIMATE_DEBUG: config.debug ? '1' : '0',
        CONTAINER_TIMEOUT_SECONDS: config.engineTimeout.toString(),
        ENGINE_MEMORY_LIMIT_BYTES: config.memLimit.toString(),
      },
    });
  if (result.code !== 0) {
    return tl.setResult(
      tl.TaskResult.Failed,
      `Code: ${result.code}\n\nErrors:\n${result.stderr}\n\nOutput:\n${result.stdout}`,
      true
    );
  }
}
