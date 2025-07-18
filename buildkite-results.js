const vscode = require('vscode');
const fetch = require('node-fetch');
const path = require('path');
const fs = require('fs');
const os = require('os');
const pLimit = require('p-limit').default;

const BUILDKITE_API_TOKEN = getTokenFromNetrc();
const BUILDS_TO_KEEP = 2;
const INCOMPLETE_STATES = ['running', 'scheduled', 'not_run', 'canceled'];
const buildkiteDiagnostics = vscode.languages.createDiagnosticCollection('buildkite');
const outputChannel = vscode.window.createOutputChannel('Buildkite Results', { log: true });
const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
const baseCacheDir = path.join(workspaceRoot, 'tmp', 'buildkite-results');
let pipelineDir = null;
let branchDidChange = false;
let schedulerTimeout = null;
let inProgress = false;
let statusBarItem;
let currentBranch = null;

function log(message) {
  const branchPart = currentBranch ? `${currentBranch} ` : '';
  const line = `${branchPart}${message}`;

  outputChannel.info(line)
}

function createStatusBarItem(context) {
  if (!hasBuildkiteFolder()) return;

  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  statusBarItem.command = 'buildkiteResults.fetchResults';
  context.subscriptions.push(statusBarItem);
}

function updateStatusBar(state) {
  if (!hasBuildkiteFolder()) return;

  let icon = '$(question)';
  let text = 'CI';
  let color = undefined;

  switch (state) {
    case 'no_build':
      icon = '$(stop)';
      color = 'gray';
      text += ' No builds';
      break;
    case 'ignored':
      icon = '$(eye-closed)';
      color = 'gray';
      text += ' Ignored branch';
      break;
    case 'fetching':
      icon = '$(sync~spin)';
      text += ' Fetching...';
      break;
    case 'annotating':
      icon = '$(sync~spin)';
      text += ' Annotating...';
      break;
    case 'passing':
      icon = '$(check)';
      color = 'lightgreen';
      text += ' Passing';
      break;
    case 'failing':
    case 'canceled':
      icon = '$(error)';
      color = 'red';
      text += ' Failing';
      break;
    case 'running':
      icon = '$(sync~spin)';
      color = 'orange';
      text += ' Running';
      break;
    default:
      icon = '$(question)';
      color = 'gray';
      text += ' Unknown';
  }

  if (statusBarItem) {
    statusBarItem.text = `${icon} ${text}`;
    statusBarItem.color = color;
    statusBarItem.show();
  }
}

function start(context) {
  registerHoverForArtifactLinks(context);
  watchBranchChanges(context);
  createStatusBarItem(context);
  manualFetchAndAnnotate();
}

function stop() {
  endPolling();
  buildkiteDiagnostics.clear();
}

function watchBranchChanges(context) {
  if (!workspaceRoot) return;

  const gitHeadPath = path.join(workspaceRoot, '.git', 'HEAD');
  let lastBranch = null;

  const checkBranch = () => {
    try {
      const headContent = fs.readFileSync(gitHeadPath, 'utf8').trim();
      const branchMatch = headContent.match(/^ref: refs\/heads\/(.+)$/);
      if (branchMatch) {
        const currentBranch = branchMatch[1];
        if (currentBranch !== lastBranch) {
          log(`Branch changed: ${currentBranch}`);
          lastBranch = currentBranch;
          branchDidChange = true;

          if (inProgress) {
            log('Fetch in progress, will handle branch change after completion.');
          } else {
            handleBranchChange();
          }
        }
      }
    } catch (_) {}
  };

  const watcher = vscode.workspace.createFileSystemWatcher('**/.git/HEAD');
  watcher.onDidChange(checkBranch);
  watcher.onDidCreate(checkBranch);
  watcher.onDidDelete(checkBranch);
  context.subscriptions.push(watcher);

  const refWatcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(workspaceRoot, `.git/refs/heads/${currentBranch}`));
  refWatcher.onDidChange(() => {
    log('Branch updated (possible push or commit)');
    handlePushOrCommit();
  });
  context.subscriptions.push(refWatcher);
}

async function handlePushOrCommit() {
  if (inProgress) return;
  await manualFetchAndAnnotate();
}

function getIgnoredBranches() {
  const config = vscode.workspace.getConfiguration('buildkiteResults');
  const raw = config.get('ignoredBranches', 'develop,main,master');
  return raw.split(',').map(b => b.trim()).filter(Boolean);
}

function handleBranchChange() {
  buildkiteDiagnostics.clear();
  branchDidChange = false;
  statusBarItem.hide();
  manualFetchAndAnnotate();
}

function endPolling() {
  if (schedulerTimeout) {
    clearTimeout(schedulerTimeout);
    schedulerTimeout = null;
  }
}

async function scheduleNext() {
  const branch = await getCurrentBranch();
  const ignored = getIgnoredBranches();

  if (ignored.includes(branch)) {
    return;
  }

  if (!isWithinWorkHours()) {
    const delay = delayUntilNextWorkStart();
    const minutes = Math.round(delay / 60000);
    log(`Outside work hours. Will retry in ${minutes} minute${minutes !== 1 ? 's' : ''}.`);
    schedulerTimeout = setTimeout(scheduleNext, delay);
    return;
  }

  if (inProgress) {
    log('Still processing, deferring next schedule.');
    schedulerTimeout = setTimeout(scheduleNext, 30 * 1000);
    return;
  }

  const state = getLastKnownBuildState(branch);
  const delay = state === 'running' ? 3 * 60 * 1000 : 15 * 60 * 1000;

  log(`Scheduling next check in ${delay / 60000} minutes`);
  schedulerTimeout = setTimeout(async () => {
    await fetchAndAnnotate();
    scheduleNext(); // requeue after run
  }, delay);
}

function delayUntilNextWorkStart() {
  const now = new Date();

  // Clone, then move the clock to 08:00 today
  const next = new Date(now);
  next.setHours(8, 0, 0, 0);

  // Already inside work hours?
  if (isWithinWorkHours()) return 0;

  // If it’s after 18:00, or it’s a weekend, bump forward
  while (
    next <= now ||               // time has passed
    next.getDay() === 0 ||       // Sunday
    next.getDay() === 6          // Saturday
  ) {
    next.setDate(next.getDate() + 1);
    next.setHours(8, 0, 0, 0);
  }

  return next - now;             // milliseconds to wait
}

function getLastKnownBuildState(branch) {
  const cached = loadPreviousMeta(branch);
  if (cached?.state) {
    return cached.state;
  }

  return null;
}

function isWithinWorkHours() {
  const now = new Date();
  const day = now.getDay(); // Sunday = 0, Saturday = 6
  const hour = now.getHours();
  return day >= 1 && day <= 5 && hour >= 8 && hour < 18;
}

function sanitizeBranchName(branch) {
  return branch.replace(/[^a-zA-Z0-9_.-]/g, '_');
}

function getTokenFromNetrc() {
  const netrcPath = path.join(os.homedir(), '.netrc');
  try {
    const content = fs.readFileSync(netrcPath, 'utf8');
    const match = content.match(/machine\s+graphql\.buildkite\.com\s+login\s+[^\s]+\s+password\s+(\S+)/);
    const token = match ? match[1] : null;
    if (!token) {
      log('Buildkite Results: No token found in .netrc');
      vscode.window.showErrorMessage('Buildkite Results: No Buildkite token found in .netrc.');
    }
    return token;
  } catch (err) {
    const message = 'Buildkite Results: Failed to read .netrc - ' + err.message;
    log(message);
    vscode.window.showErrorMessage(message);
    return null;
  }
}

function getPipelineFromRepoFolder() {
  if (pipelineDir) return pipelineDir;

  pipelineDir = path.basename(workspaceRoot);
  log(`Inferred pipeline from folder name: ${pipelineDir}`);
  return pipelineDir;
}

function hasBuildkiteFolder() {
  const buildkiteFolder = path.join(workspaceRoot, '.buildkite');
  return fs.existsSync(buildkiteFolder) && fs.statSync(buildkiteFolder).isDirectory();
}

function getBuildFolderPath(branch, buildNumber) {
  const sanitized = sanitizeBranchName(branch);
  return path.join(baseCacheDir, sanitized, String(buildNumber));
}

function getArtifactFilePath(branch, buildNumber, jobId, filename = 'rspec_results.json') {
  return path.join(getBuildFolderPath(branch, buildNumber), String(jobId), filename);
}

function cleanupOldBuildFolders(branch) {
  const sanitized = sanitizeBranchName(branch);
  const branchDir = path.join(baseCacheDir, sanitized);
  if (!fs.existsSync(branchDir)) return;

  const entries = fs.readdirSync(branchDir, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => entry.name)
    .filter(name => /^\d+$/.test(name))
    .map(name => Number(name))
    .sort((a, b) => b - a);

  const buildsToKeep = entries.slice(0, BUILDS_TO_KEEP);
  const buildsToDelete = entries.filter(num => !buildsToKeep.includes(num));

  for (const build of buildsToDelete) {
    const dir = path.join(branchDir, String(build));
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      log(`Deleted old build folder: ${dir}`);
    } catch (err) {
      log(`Failed to delete build folder ${dir}: ${err.message}`);
    }
  }
}

async function getCurrentBranch() {
  try {
    const head = fs.readFileSync(path.join(workspaceRoot, '.git', 'HEAD'), 'utf8').trim();
    const match = head.match(/^ref: refs\/heads\/(.+)$/);
    const branch = match ? match[1] : null;
    currentBranch = branch;
    return branch;
  } catch (err) {
    log('Error reading git branch: ' + err.message);
    return null;
  }
}

async function fetchLatestBuildREST(org, pipeline, branch) {
  log('Fetching latest build...');
  const url = `https://api.buildkite.com/v2/organizations/${org}/pipelines/${pipeline}/builds?branch=${encodeURIComponent(branch)}&per_page=1`;

  const res = await fetch(url, {
    headers: {
      'Authorization': `Bearer ${BUILDKITE_API_TOKEN}`,
      'Content-Type': 'application/json',
    },
  });

  if (!res.ok) {
    const text = await res.text();
    log(`REST API request failed: ${res.status} ${res.statusText}\n${text}`);
    return null;
  }

  const builds = await res.json();
  return builds[0] || null;
}

async function fetchRspecResultsArtifact(org, pipeline, branch, buildNumber, jobId) {
  const artifactsUrl = `https://api.buildkite.com/v2/organizations/${org}/pipelines/${pipeline}/builds/${buildNumber}/jobs/${jobId}/artifacts`;

  const res = await fetch(artifactsUrl, {
    headers: {
      'Authorization': `Bearer ${BUILDKITE_API_TOKEN}`,
      'Content-Type': 'application/json',
    },
  });

  if (!res.ok) {
    log(`Failed to fetch artifacts for job ${jobId}`);
    return null;
  }

  const artifacts = await res.json();
  const rspecArtifact = artifacts.find(a => a.path.endsWith('rspec_results.json'));
  if (!rspecArtifact) return;

  const artifactDownloadRes = await fetch(rspecArtifact.download_url, {
    headers: {
      'Authorization': `Bearer ${BUILDKITE_API_TOKEN}`
    }
  });

  if (!artifactDownloadRes.ok) {
    log(`Failed to download rspec_results.json: ${artifactDownloadRes.status}`);
    return null;
  }

  const artifactPath = getArtifactFilePath(branch, buildNumber, jobId);

  try {
    const json = await artifactDownloadRes.json();
    fs.mkdirSync(path.dirname(artifactPath), { recursive: true });
    fs.writeFileSync(artifactPath, JSON.stringify(json, null, 2));
    return json;
  } catch (err) {
    log(`Failed to process or save rspec_results.json: ${err.message}`);
    return null;
  }
}

async function fetchArtifactDownloadUrl(org, pipeline, buildNumber, jobId, pathSuffix, outputDir) {
  const artifactsUrl = `https://api.buildkite.com/v2/organizations/${org}/pipelines/${pipeline}/builds/${buildNumber}/jobs/${jobId}/artifacts`;
  const res = await fetch(artifactsUrl, {
    headers: {
      'Authorization': `Bearer ${BUILDKITE_API_TOKEN}`,
      'Content-Type': 'application/json',
    },
  });

  if (!res.ok) {
    log(`Failed to fetch artifacts for download resolution`, `warn`);
    return null;
  }

  const artifacts = await res.json();
  const artifact = artifacts.find(a => a.path.endsWith(pathSuffix));
  if (!artifact) return null;

  const artifactRes = await fetch(artifact.download_url, {
    headers: {
      'Authorization': `Bearer ${BUILDKITE_API_TOKEN}`
    }
  });

  if (!artifactRes.ok) {
    log(`Failed to download artifact ${pathSuffix}: ${artifactRes.status}`);
    return null;
  }

  const localPath = path.join(outputDir, pathSuffix);
  try {
    fs.mkdirSync(path.dirname(localPath), { recursive: true });
    const buffer = await artifactRes.buffer();
    fs.writeFileSync(localPath, buffer);
    return localPath;
  } catch (err) {
    log(`Failed to save artifact ${pathSuffix}: ${err.message}`);
    return null;
  }
}

async function extractResultsFromRspecJson(json, org, pipeline, branch, buildNumber, jobId) {
  const resultsMap = new Map();
  const outputDir = path.join(getBuildFolderPath(branch, buildNumber), String(jobId));

  await fs.promises.mkdir(outputDir, { recursive: true });

  for (const example of json.examples) {
    if (example.status !== 'failed') continue;

    const fullPath = path.resolve(workspaceRoot, example.file_path);
    const uri = vscode.Uri.file(fullPath);

    const baseMessage = `${example.full_description}\n`;
    const exceptionClass = example.exception?.class || 'Error';
    const errorMessage = example.exception?.message || 'RSpec test failure';
    const backtrace = example.exception?.backtrace || [];

    let backtraceFileLink = '';
    if (backtrace.length > 0) {
      const btPath = path.join(outputDir, `backtrace-${example.line_number}.txt`);
      try {
        if (!fs.existsSync(btPath)) {
          await fs.promises.writeFile(btPath, backtrace.join('\n'));
        }
        backtraceFileLink = `Full Backtrace: ${vscode.Uri.file(btPath).toString()}`;
      } catch (err) {
        log(`Failed to save backtrace file: ${err.message}`);
      }
    }

    let screenshots = '';
    if (example.screenshot) {
      const parts = [];
      if (example.screenshot.image) {
        const localImagePath = path.join(outputDir, path.basename(example.screenshot.image));
        if (!fs.existsSync(localImagePath)) {
          const local = await fetchArtifactDownloadUrl(org, pipeline, buildNumber, jobId, path.basename(example.screenshot.image), outputDir);
          if (local) parts.push(`Image: ${vscode.Uri.file(local).toString()}`);
        } else {
          parts.push(`Image: ${vscode.Uri.file(localImagePath).toString()}`);
        }
      }
      if (example.screenshot.html) {
        const localHtmlPath = path.join(outputDir, path.basename(example.screenshot.html));
        if (!fs.existsSync(localHtmlPath)) {
          const local = await fetchArtifactDownloadUrl(org, pipeline, buildNumber, jobId, path.basename(example.screenshot.html), outputDir);
          if (local) parts.push(`HTML: ${vscode.Uri.file(local).toString()}`);
        } else {
          parts.push(`HTML: ${vscode.Uri.file(localHtmlPath).toString()}`);
        }
      }
      screenshots = parts.join('\n');
    }

    const links = [backtraceFileLink, screenshots].filter(Boolean).join('\n');

    const briefBacktrace = `${backtrace.slice(0, 5).join('\n')}\n\n---------------------`;
    const details = [exceptionClass, errorMessage, briefBacktrace, links]
      .filter(Boolean)
      .join('\n\n');

    const result = new vscode.Diagnostic(
      new vscode.Range(
        new vscode.Position(Number(example.line_number) - 1, 0),
        new vscode.Position(Number(example.line_number) - 1, 100)
      ),
      `${baseMessage}\n${details}`,
      vscode.DiagnosticSeverity.Error
    );

    if (!resultsMap.has(uri)) {
      resultsMap.set(uri, []);
    }
    resultsMap.get(uri).push(result);
  }

  return resultsMap;
}

function loadPreviousMeta(branch) {
  const sanitized = sanitizeBranchName(branch);
  const branchDir = path.join(baseCacheDir, sanitized);
  if (!fs.existsSync(branchDir)) return {};

  const builds = fs.readdirSync(branchDir).filter(name => /^\d+$/.test(name)).map(Number).sort((a, b) => b - a);
  if (builds.length === 0) return {};

  const lastBuild = builds[0];
  const metaPath = path.join(branchDir, String(lastBuild), 'meta.json');
  if (!fs.existsSync(metaPath)) return {};

  try {
    return JSON.parse(fs.readFileSync(metaPath, 'utf8'));
  } catch {
    return {};
  }
}

function saveMeta(branch, buildNumber, meta) {
  const metaPath = path.join(getBuildFolderPath(branch, buildNumber), 'meta.json');
  try {
    fs.mkdirSync(path.dirname(metaPath), { recursive: true });
    fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
  } catch (err) {
    log(`Failed to write meta: ${err.message}`);
  }
}

async function manualFetchAndAnnotate() {
  if (schedulerTimeout) {
    clearTimeout(schedulerTimeout);
    schedulerTimeout = null;
  }

  await fetchAndAnnotate();
  scheduleNext();
}

async function fetchAndAnnotate() {
  const branch = await getCurrentBranch();
  const ignored = getIgnoredBranches();

  if (ignored.includes(branch)) {
    updateStatusBar('ignored');
    return;
  }

  if (inProgress) {
    return;
  }

  inProgress = true;
  try {
    updateStatusBar('fetching');
    const results = await fetchBuild();

    if (branchDidChange) {
      inProgress = false;
      handleBranchChange();
      return;
    }

    if (results) {
      updateStatusBar('annotating');
      const build = await annotateFailures(results);
      log(`Build #${build.number} [${buildState(build)}]`);
      updateStatusBar(buildState(build));
    } else {
      updateStatusBar('no_build');
    }
  } catch (err) {
    log(`Error during fetch or annotation: ${err.message}`);
  } finally {
    inProgress = false;
  }
}

function buildState(build) {
  if (INCOMPLETE_STATES.includes(build.state)) {
    return 'running';
  } else if (build.state === 'passed') {
    return 'passing';
  } else if (build.state === 'failed') {
    return 'failing';
  }
  return build.state;
}

async function validateEnvironment() {
  if (!hasBuildkiteFolder()) {
    log('No .buildkite folder found, exiting.');
    return;
  }

  log('Fetching Buildkite results...');
  const pipeline = getPipelineFromRepoFolder();
  const config = vscode.workspace.getConfiguration('buildkiteResults');
  const org = config.get('org');
  const branch = await getCurrentBranch();

  if (!org || !pipeline || !branch || !BUILDKITE_API_TOKEN) {
    log('Missing required parameters: org, pipeline, branch, or api token.');
    return;
  }

  return { org, pipeline, branch };
}

async function fetchBuild() {
  const env = await validateEnvironment();
  if (!env) return;

  const { org, pipeline, branch } = env;

  const build = await fetchLatestBuildREST(org, pipeline, branch);
  if (!build) {
    log(`No build found for ${org}/${pipeline} on branch ${branch}`);
    return;
  }

  return { build, org, pipeline, branch };
}

async function annotateFailures({ build, org, pipeline, branch }) {
  const previousMeta = loadPreviousMeta(branch);
  const isCached = previousMeta.build_number === build.number && previousMeta.state === build.state;

  buildkiteDiagnostics.clear();

  const allJobsComplete = build.jobs.every(j => !INCOMPLETE_STATES.includes(j.state));

  const meta = {
    build_number: build.number,
    state: allJobsComplete ? build.state : 'running',
    jobs: {}
  };

  const limit = pLimit(4);
  const combinedDiagnostics = new Map();

  const jobTasks = build.jobs.map(job =>
    limit(async () => {
      const artifactPath = getArtifactFilePath(branch, build.number, job.id);
      const wasCached = previousMeta.jobs?.[job.id]?.artifact_cached;

      let json;

      if (fs.existsSync(artifactPath)) {
        json = JSON.parse(fs.readFileSync(artifactPath, 'utf8'));
      } else if (!isCached) {
        if (wasCached) return;

        json = await fetchRspecResultsArtifact(org, pipeline, branch, build.number, job.id);
        if (!json) return;
      } else {
        return;
      }

      const resultsMap = await extractResultsFromRspecJson(json, org, pipeline, branch, build.number, job.id);

      for (const [uri, results] of resultsMap.entries()) {
        const key = uri.fsPath;
        if (!combinedDiagnostics.has(key)) {
          combinedDiagnostics.set(key, { uri, diagnostics: [] });
        }
        combinedDiagnostics.get(key).diagnostics.push(...results);
      }

      meta.jobs[job.id] = { state: job.state, artifact_cached: true };
    })
  );

  log('Annotating...');
  await Promise.allSettled(jobTasks);

  for (const { uri, diagnostics } of combinedDiagnostics.values()) {
    const seen = new Set();
    const unique = diagnostics.filter(d => {
      const key = `${d.range.start.line}:${d.message}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    buildkiteDiagnostics.set(uri, unique);
  }

  if (!isCached) {
    saveMeta(branch, build.number, meta);
  }

  cleanupOldBuildFolders(branch);

  return build;
}

function registerHoverForArtifactLinks(context) {
  context.subscriptions.push(
    vscode.languages.registerHoverProvider({ scheme: 'file' }, {
      provideHover(document, position, token) {
        const diagnostics = vscode.languages.getDiagnostics(document.uri).filter(diag => diag.range.contains(position));
        if (!diagnostics.length) return;

        const markdownLinks = [];
        for (const diag of diagnostics) {
          const matches = diag.message.match(/file:[^\s)\]]+/g);
          if (matches) {
            for (const match of matches) {
              const label = path.basename(match);
              markdownLinks.push(`[${label}](${match})`);
            }
          }
        }

        if (markdownLinks.length) {
          return new vscode.Hover(new vscode.MarkdownString(markdownLinks.join('  \n')));
        }
      }
    })
  );
}

module.exports = {
  manualFetchAndAnnotate,
  start,
  stop
};
