import fs from 'fs';
import path from 'path';
import os from 'os';

export interface ApprovedDirectoryRoot {
  id: string;
  label: string;
  path: string;
}

export interface ApprovedDirectory {
  name: string;
  path: string;
  rootId: string;
  rootLabel: string;
}

function getApprovedDirectoryRoots(): ApprovedDirectoryRoot[] {
  const roots: ApprovedDirectoryRoot[] = [];

  // 1. Check for custom allowed directories from environment variable
  const envAllowed = process.env.APPROVED_DIRECTORIES;
  if (envAllowed) {
    const parts = envAllowed.split(',');
    parts.forEach((part, idx) => {
      const trimmed = part.trim();
      if (!trimmed) return;

      // Format can be "id:label:path" or just "path"
      // Since Windows paths contain colons (e.g. C:\dev), we check if there are at least 2 colons
      // for the "id:label:drive:\path" format.
      const colonCount = (trimmed.match(/:/g) || []).length;
      if (colonCount >= 2 && !/^[a-zA-Z]:/.test(trimmed)) {
        const firstColon = trimmed.indexOf(':');
        const secondColon = trimmed.indexOf(':', firstColon + 1);
        if (firstColon !== -1 && secondColon !== -1) {
          const id = trimmed.slice(0, firstColon).trim();
          const label = trimmed.slice(firstColon + 1, secondColon).trim();
          const pathVal = trimmed.slice(secondColon + 1).trim();
          roots.push({ id, label, path: pathVal });
          return;
        }
      }

      roots.push({
        id: `env_dir_${idx}`,
        label: `Allowed Directory ${idx + 1}`,
        path: trimmed,
      });
    });
  }

  // 2. Fall back to safe dynamic defaults if none specified
  if (roots.length === 0) {
    const homeDir = os.homedir();
    roots.push({ id: 'user_profile', label: 'User profile', path: homeDir });
    roots.push({ id: 'agent_workspace', label: 'Agent Workspace', path: 'C:\\Agent' });
    roots.push({ id: 'dev', label: 'Development', path: 'C:\\dev' });

    // Add common subdirectories if they exist
    const desktop = path.win32.join(homeDir, 'Desktop');
    if (fs.existsSync(desktop)) {
      roots.push({ id: 'desktop', label: 'Desktop', path: desktop });
    }
    const documents = path.win32.join(homeDir, 'Documents');
    if (fs.existsSync(documents)) {
      roots.push({ id: 'documents', label: 'Documents', path: documents });
    }
    const downloads = path.win32.join(homeDir, 'Downloads');
    if (fs.existsSync(downloads)) {
      roots.push({ id: 'downloads', label: 'Downloads', path: downloads });
    }
  }

  const homeDirEnv = process.env.DC_HOME_DIR?.trim();
  if (homeDirEnv) {
    if (!roots.some((r) => r.path.toLowerCase() === homeDirEnv.toLowerCase())) {
      roots.unshift({ id: 'home_dir', label: 'Home directory', path: homeDirEnv });
    }
  }

  return roots;
}

export const APPROVED_DIRECTORY_ROOTS: ApprovedDirectoryRoot[] = [];

export function refreshApprovedDirectoryRoots(): ApprovedDirectoryRoot[] {
  const current = getApprovedDirectoryRoots();
  APPROVED_DIRECTORY_ROOTS.length = 0;
  APPROVED_DIRECTORY_ROOTS.push(...current);
  return APPROVED_DIRECTORY_ROOTS;
}

// Initial population
refreshApprovedDirectoryRoots();

const PATH_ARG_NAMES = new Set([
  'path',
  'paths',
  'file',
  'files',
  'filePath',
  'file_path',
  'filePaths',
  'file_paths',
  'folder',
  'folderPath',
  'folder_path',
  'directory',
  'directoryPath',
  'directory_path',
  'dir',
  'source',
  'sourcePath',
  'source_path',
  'destination',
  'destinationPath',
  'destination_path',
  'target',
  'targetPath',
  'target_path',
  'oldPath',
  'old_path',
  'newPath',
  'new_path',
  'from',
  'to',
]);

const COMMAND_TOOL_NAMES = new Set(['execute_command', 'start_process']);

export function getDirectoryRoots(): ApprovedDirectory[] {
  refreshApprovedDirectoryRoots();
  return APPROVED_DIRECTORY_ROOTS.map((root) => ({
    name: root.label,
    path: canonicalizeWindowsPath(root.path),
    rootId: root.id,
    rootLabel: root.label,
  }));
}

export function validateDirectoryPath(input: string, options: { mustExist?: boolean } = {}): ApprovedDirectory {
  const canonical = canonicalizeWindowsPath(input);
  const root = findContainingRoot(canonical);
  if (!root) {
    throw new Error(`Path is outside the approved directories: ${input}`);
  }

  if (options.mustExist) {
    let realPath: string;
    try {
      const stat = fs.statSync(canonical);
      if (!stat.isDirectory()) {
        throw new Error('Path is not a directory');
      }
      realPath = fs.realpathSync.native(canonical);
    } catch (error: any) {
      throw new Error(`Directory is not available: ${input} (${error.message})`);
    }
    const realCanonical = canonicalizeWindowsPath(realPath);
    const realRoot = findContainingRoot(realCanonical);
    if (!realRoot) {
      throw new Error(`Directory resolves outside the approved directories: ${input}`);
    }
    return {
      name: path.win32.basename(realCanonical) || realCanonical,
      path: realCanonical,
      rootId: realRoot.id,
      rootLabel: realRoot.label,
    };
  }

  return {
    name: path.win32.basename(canonical) || canonical,
    path: canonical,
    rootId: root.id,
    rootLabel: root.label,
  };
}

export function listApprovedChildDirectories(input: string): ApprovedDirectory[] {
  const parent = validateDirectoryPath(input, { mustExist: true });
  const entries = fs.readdirSync(parent.path, { withFileTypes: true });
  const directories: ApprovedDirectory[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    try {
      const child = validateDirectoryPath(path.win32.join(parent.path, entry.name), { mustExist: true });
      directories.push({ ...child, name: entry.name });
    } catch {
      // Hidden by policy: unavailable directories and symlinks outside approved roots are not selectable.
    }
  }

  return directories.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
}

export function sanitizeExecutionArgs(
  toolName: string,
  args: Record<string, unknown>,
  selectedDirectory?: string
): Record<string, unknown> {
  const sanitized: Record<string, unknown> = { ...args };
  const actualToolName = unprefixToolName(toolName);

  if (COMMAND_TOOL_NAMES.has(actualToolName)) {
    const cwd = typeof sanitized.cwd === 'string' && sanitized.cwd.trim()
      ? sanitized.cwd
      : selectedDirectory;
    if (!cwd) {
      throw new Error('Select an approved directory or provide an approved cwd before running commands.');
    }
    sanitized.cwd = validateDirectoryPath(cwd).path;
  } else if (typeof sanitized.cwd === 'string') {
    sanitized.cwd = validateDirectoryPath(sanitized.cwd).path;
  }

  for (const key of Object.keys(sanitized)) {
    if (!PATH_ARG_NAMES.has(key)) continue;
    sanitized[key] = sanitizePathValue(sanitized[key], selectedDirectory);
  }

  return sanitized;
}

export function prepareDesktopCommanderArgs(
  toolName: string,
  args: Record<string, unknown>,
  selectedDirectory?: string
): Record<string, unknown> {
  const sanitized = sanitizeExecutionArgs(toolName, args, selectedDirectory);
  const actualToolName = unprefixToolName(toolName);
  if (!COMMAND_TOOL_NAMES.has(actualToolName)) {
    return sanitized;
  }

  const cwd = typeof sanitized.cwd === 'string' ? sanitized.cwd : undefined;
  const command = typeof sanitized.command === 'string' ? sanitized.command : undefined;
  if (!cwd || !command) {
    throw new Error('Command tools require command and approved cwd');
  }

  const prepared = { ...sanitized };
  delete prepared.cwd;
  prepared.command = withWorkingDirectory(command, cwd, typeof prepared.shell === 'string' ? prepared.shell : undefined);
  return prepared;
}

export function requireApprovedCwd(args: { cwd?: string }, selectedDirectory?: string): string {
  const cwd = typeof args.cwd === 'string' && args.cwd.trim() ? args.cwd : selectedDirectory;
  if (!cwd) {
    throw new Error('Select an approved directory or provide an approved cwd before starting a job.');
  }
  return validateDirectoryPath(cwd).path;
}

function sanitizePathValue(value: unknown, selectedDirectory?: string): unknown {
  if (typeof value === 'string') {
    return resolveSelectedPath(value, selectedDirectory);
  }
  if (Array.isArray(value)) {
    return value.map((item) => {
      if (typeof item !== 'string') return item;
      return resolveSelectedPath(item, selectedDirectory);
    });
  }
  return value;
}

function resolveSelectedPath(input: string, selectedDirectory?: string): string {
  const value = input.trim();
  if (!value) throw new Error('Path argument cannot be empty');
  if (isAbsoluteWindowsPath(value)) {
    return validateDirectoryPath(value).path;
  }
  if (!selectedDirectory) {
    throw new Error(`Relative path requires a selected approved directory: ${input}`);
  }
  return validateDirectoryPath(path.win32.join(selectedDirectory, value)).path;
}

function canonicalizeWindowsPath(input: string): string {
  if (typeof input !== 'string' || !input.trim()) {
    throw new Error('Path is required');
  }

  const trimmed = input.trim();
  if (trimmed.includes('\0')) {
    throw new Error('Path contains a null byte');
  }
  if (trimmed.startsWith('\\\\') || trimmed.startsWith('//')) {
    throw new Error('UNC paths are not approved');
  }
  if (!isAbsoluteWindowsPath(trimmed)) {
    throw new Error(`Path must be an absolute Windows path: ${input}`);
  }

  const normalized = path.win32.resolve(trimmed);
  const parsed = path.win32.parse(normalized);
  if (!parsed.root || parsed.root.startsWith('\\\\')) {
    throw new Error(`Path must be on a local drive: ${input}`);
  }
  return uppercaseDriveLetter(stripTrailingSlash(normalized));
}

function isAbsoluteWindowsPath(input: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(input);
}

function findContainingRoot(canonicalPath: string): ApprovedDirectoryRoot | undefined {
  refreshApprovedDirectoryRoots();
  const pathKey = canonicalPath.toLowerCase();
  return APPROVED_DIRECTORY_ROOTS
    .map((root) => ({ ...root, path: canonicalizeRoot(root.path) }))
    .find((root) => pathKey === root.path.toLowerCase() || pathKey.startsWith(`${root.path.toLowerCase()}\\`));
}

function canonicalizeRoot(rootPath: string): string {
  return stripTrailingSlash(path.win32.resolve(rootPath));
}

function stripTrailingSlash(input: string): string {
  return input.replace(/[\\/]+$/, '');
}

function uppercaseDriveLetter(input: string): string {
  return /^[a-z]:/.test(input) ? `${input[0].toUpperCase()}${input.slice(1)}` : input;
}

function withWorkingDirectory(command: string, cwd: string, shell?: string): string {
  const shellKey = (shell ?? 'powershell').toLowerCase();
  if (shellKey.includes('powershell') || shellKey.includes('pwsh')) {
    return `Set-Location -LiteralPath '${cwd.replace(/'/g, "''")}'; ${resolvePowerShellExecutable(command)}`;
  }
  if (shellKey === 'cmd' || shellKey.endsWith('\\cmd.exe') || shellKey.endsWith('/cmd.exe')) {
    return `cd /d "${cwd.replace(/"/g, '""')}" && ${command}`;
  }
  if (shellKey.includes('bash') || shellKey.endsWith('/sh') || shellKey.endsWith('\\sh.exe')) {
    return `cd '${cwd.replace(/'/g, `'\\''`)}' && ${command}`;
  }
  return `Set-Location -LiteralPath '${cwd.replace(/'/g, "''")}'; ${resolvePowerShellExecutable(command)}`;
}

function resolvePowerShellExecutable(command: string): string {
  const match = command.match(/^(\s*&\s*)?(?:"([^"]+)"|'([^']+)'|([A-Za-z][\w.-]*))(.*)$/s);
  if (!match) return command;

  const executable = match[2] ?? match[3] ?? match[4];
  const rest = match[5] ?? '';
  if (!executable || executable.includes('\\') || executable.includes('/')) {
    return command;
  }
  if (!shouldResolveWindowsExecutable(executable)) {
    return command;
  }

  const resolved = resolveExecutableOnPath(executable);
  if (!resolved) return command;

  return `& '${resolved.replace(/'/g, "''")}'${rest}`;
}

function shouldResolveWindowsExecutable(executable: string): boolean {
  const normalized = executable.toLowerCase().replace(/\.exe$/, '');
  return normalized === 'python'
    || normalized === 'python3'
    || normalized === 'py'
    || normalized === 'powershell'
    || normalized === 'pwsh'
    || normalized === 'cmd';
}

function resolveExecutableOnPath(executable: string): string | undefined {
  const pathEnv = process.env.PATH ?? process.env.Path ?? process.env.path ?? '';
  const pathExt = (process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD')
    .split(';')
    .filter(Boolean);
  const names = path.extname(executable)
    ? [executable]
    : [executable, ...pathExt.map((ext) => `${executable}${ext}`)];

  for (const dir of pathEnv.split(path.delimiter)) {
    const trimmed = dir.trim();
    if (!trimmed) continue;
    for (const name of names) {
      const candidate = path.win32.join(trimmed, name);
      if (fs.existsSync(candidate)) return candidate;
    }
  }

  for (const candidate of getKnownWindowsExecutables(executable)) {
    if (fs.existsSync(candidate)) return candidate;
  }

  return undefined;
}

function getKnownWindowsExecutables(executable: string): string[] {
  const normalized = executable.toLowerCase().replace(/\.exe$/, '');
  const windir = process.env.WINDIR ?? 'C:\\Windows';
  if (normalized === 'powershell') {
    return [path.win32.join(windir, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')];
  }
  if (normalized === 'cmd') {
    return [path.win32.join(windir, 'System32', 'cmd.exe')];
  }
  if (normalized === 'py') {
    return [path.win32.join(windir, 'py.exe')];
  }
  if (normalized === 'python' || normalized === 'python3') {
    return [
      'C:\\Python314\\python.exe',
      'C:\\Python313\\python.exe',
      'C:\\Python312\\python.exe',
      'C:\\Python311\\python.exe',
      'C:\\Python310\\python.exe',
    ];
  }
  return [];
}

function unprefixToolName(toolName: string): string {
  const separator = toolName.indexOf('_');
  if (separator === -1) return toolName;
  const suffix = toolName.slice(separator + 1);
  return COMMAND_TOOL_NAMES.has(suffix) ? suffix : toolName;
}
