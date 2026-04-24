const fs = require('fs');
const os = require('os');
const path = require('path');

const APP_NAME = 'brAInstorm';
const APP_SLUG = 'brainstorm';
const LEGACY_APP_DATA_DIRS = ['proxima'];
const SKILL_FILE_EXTENSION = '.md';

let cachedSkills = new Map();
let cachedSkillsDirectory = null;
let cachedLoadedAt = null;

function normalizeSkillName(skillName) {
    return String(skillName || '')
        .trim()
        .replace(/\.md$/i, '')
        .replace(/[^a-zA-Z0-9_-]+/g, '_')
        .toLowerCase();
}

function resolveSkillsDirectory() {
    const projectRoot = path.resolve(__dirname, '..');
    const envDir = typeof process.env.BRAINSTORM_SKILLS_DIR === 'string'
        ? process.env.BRAINSTORM_SKILLS_DIR.trim()
        : typeof process.env.PROXIMA_SKILLS_DIR === 'string'
            ? process.env.PROXIMA_SKILLS_DIR.trim()
        : '';
    const bundledSkillsDir = path.join(projectRoot, 'skills');

    if (envDir) {
        const preparedEnvDir = prepareWritableSkillsDirectory(envDir, bundledSkillsDir);
        return preparedEnvDir || envDir;
    }

    if (isLikelySourceCheckout(projectRoot) && isDirectoryWritable(bundledSkillsDir)) {
        return bundledSkillsDir;
    }

    const writableCandidates = getWritableSkillsDirectoryCandidates();

    for (const candidate of writableCandidates) {
        if (isDirectoryWritable(candidate)) {
            return candidate;
        }
    }

    for (const candidate of writableCandidates) {
        const preparedDirectory = prepareWritableSkillsDirectory(candidate, bundledSkillsDir);
        if (preparedDirectory) {
            return preparedDirectory;
        }
    }

    return bundledSkillsDir;
}

function isDirectory(candidatePath) {
    try {
        return fs.existsSync(candidatePath) && fs.statSync(candidatePath).isDirectory();
    } catch (error) {
        return false;
    }
}

function isPathWritable(candidatePath) {
    try {
        fs.accessSync(candidatePath, fs.constants.W_OK);
        return true;
    } catch (error) {
        return false;
    }
}

function isDirectoryWritable(candidatePath) {
    return isDirectory(candidatePath) && isPathWritable(candidatePath);
}

function findNearestExistingParent(candidatePath) {
    let currentPath = path.resolve(candidatePath);

    while (true) {
        if (fs.existsSync(currentPath)) {
            return currentPath;
        }

        const parentPath = path.dirname(currentPath);
        if (parentPath === currentPath) {
            return null;
        }

        currentPath = parentPath;
    }
}

function canCreateDirectory(candidatePath) {
    const existingParent = findNearestExistingParent(candidatePath);
    return !!existingParent && isPathWritable(existingParent);
}

function getAppDataBaseDirectory() {
    if (process.platform === 'win32') {
        return process.env.APPDATA || '';
    }

    if (process.platform === 'darwin') {
        return path.join(os.homedir(), 'Library', 'Application Support');
    }

    return path.join(os.homedir(), '.config');
}

function getWritableSkillsDirectoryCandidates() {
    const baseDirectory = getAppDataBaseDirectory();
    if (!baseDirectory) {
        return [];
    }

    return [APP_NAME, APP_SLUG, ...LEGACY_APP_DATA_DIRS]
        .map((dirName) => path.join(baseDirectory, dirName, 'skills'))
        .filter((candidatePath, index, list) => candidatePath && list.indexOf(candidatePath) === index);
}

function isLikelySourceCheckout(projectRoot) {
    return fs.existsSync(path.join(projectRoot, 'package.json')) &&
        fs.existsSync(path.join(projectRoot, 'electron', 'main-v2.cjs'));
}

function seedSkillsDirectory(targetDirectory, sourceDirectory) {
    if (!isDirectory(sourceDirectory) || path.resolve(targetDirectory) === path.resolve(sourceDirectory)) {
        return;
    }

    const sourceFileNames = fs.readdirSync(sourceDirectory)
        .filter((fileName) => fileName.toLowerCase().endsWith(SKILL_FILE_EXTENSION))
        .sort((a, b) => a.localeCompare(b));

    for (const fileName of sourceFileNames) {
        const sourceFilePath = path.join(sourceDirectory, fileName);
        const targetFilePath = path.join(targetDirectory, fileName);

        if (!fs.statSync(sourceFilePath).isFile() || fs.existsSync(targetFilePath)) {
            continue;
        }

        fs.copyFileSync(sourceFilePath, targetFilePath);
    }
}

function prepareWritableSkillsDirectory(candidateDirectory, seedSourceDirectory) {
    if (isDirectoryWritable(candidateDirectory)) {
        return candidateDirectory;
    }

    if (isDirectory(candidateDirectory)) {
        return null;
    }

    if (!canCreateDirectory(candidateDirectory)) {
        return null;
    }

    try {
        fs.mkdirSync(candidateDirectory, { recursive: true });
        seedSkillsDirectory(candidateDirectory, seedSourceDirectory);
        return candidateDirectory;
    } catch (error) {
        return null;
    }
}

function extractTemplateVariables(template) {
    const variableNames = new Set();
    const matches = String(template || '').matchAll(/\$\{([a-zA-Z0-9_]+)\}/g);

    for (const match of matches) {
        if (match[1]) {
            variableNames.add(match[1]);
        }
    }

    return Array.from(variableNames).sort();
}

function buildSkillRecord(filePath) {
    const template = fs.readFileSync(filePath, 'utf8');
    const fileName = path.basename(filePath);
    const name = normalizeSkillName(fileName);

    return {
        name,
        fileName,
        filePath,
        template,
        variables: extractTemplateVariables(template)
    };
}

function refreshSkillRegistry() {
    const skillsDirectory = resolveSkillsDirectory();
    const nextRegistry = new Map();

    if (fs.existsSync(skillsDirectory) && fs.statSync(skillsDirectory).isDirectory()) {
        const fileNames = fs.readdirSync(skillsDirectory)
            .filter((fileName) => fileName.toLowerCase().endsWith(SKILL_FILE_EXTENSION))
            .sort((a, b) => a.localeCompare(b));

        for (const fileName of fileNames) {
            const filePath = path.join(skillsDirectory, fileName);
            if (!fs.statSync(filePath).isFile()) {
                continue;
            }

            const skillRecord = buildSkillRecord(filePath);
            if (skillRecord.name) {
                nextRegistry.set(skillRecord.name, skillRecord);
            }
        }
    }

    cachedSkills = nextRegistry;
    cachedSkillsDirectory = skillsDirectory;
    cachedLoadedAt = new Date().toISOString();
    return listSkills({ includeTemplate: true, refresh: false });
}

function ensureSkillRegistry(options = {}) {
    const refreshRequested = options.refresh !== false;
    const shouldRefresh = refreshRequested ||
        !cachedLoadedAt ||
        cachedSkillsDirectory !== resolveSkillsDirectory();

    if (shouldRefresh) {
        refreshSkillRegistry();
    }

    return cachedSkills;
}

function listSkills(options = {}) {
    ensureSkillRegistry({ refresh: options.refresh });

    return Array.from(cachedSkills.values()).map((skill) => ({
        name: skill.name,
        fileName: skill.fileName,
        filePath: skill.filePath,
        variables: [...skill.variables],
        ...(options.includeTemplate ? { template: skill.template } : {})
    }));
}

function getSkill(skillName, options = {}) {
    const normalizedName = normalizeSkillName(skillName);
    if (!normalizedName) {
        return null;
    }

    const registry = ensureSkillRegistry({ refresh: options.refresh });
    if (registry.has(normalizedName)) {
        return registry.get(normalizedName);
    }

    if (options.refreshOnMiss !== false) {
        refreshSkillRegistry();
        return cachedSkills.get(normalizedName) || null;
    }

    return null;
}

function hasSkill(skillName, options = {}) {
    return !!getSkill(skillName, options);
}

function getSkillFilePath(skillName) {
    return getSkill(skillName)?.filePath || null;
}

function readSkillTemplate(skillName, options = {}) {
    return getSkill(skillName, options)?.template || null;
}

function stringifyTemplateValue(value) {
    if (value === null || value === undefined) {
        return '';
    }

    if (Array.isArray(value)) {
        return value.join(', ');
    }

    if (typeof value === 'object') {
        return JSON.stringify(value, null, 2);
    }

    return String(value);
}

function renderTemplate(template, variables = {}) {
    return String(template || '').replace(/\$\{([a-zA-Z0-9_]+)\}/g, (match, variableName) => {
        if (!Object.prototype.hasOwnProperty.call(variables, variableName)) {
            return '';
        }

        return stringifyTemplateValue(variables[variableName]);
    }).trim();
}

function renderSkillPrompt(skillName, variables = {}, options = {}) {
    const skill = getSkill(skillName, { refresh: options.refresh, refreshOnMiss: options.refreshOnMiss });

    if (skill) {
        return renderTemplate(skill.template, variables);
    }

    if (typeof options.fallbackText === 'string' && options.fallbackText.trim()) {
        return renderTemplate(options.fallbackText, variables);
    }

    throw new Error(`Missing skill prompt template: ${skillName}`);
}

function getSkillRegistrySummary(options = {}) {
    const skills = listSkills(options);
    return {
        directory: cachedSkillsDirectory || resolveSkillsDirectory(),
        loadedAt: cachedLoadedAt,
        skills
    };
}

refreshSkillRegistry();

module.exports = {
    getSkill,
    getSkillFilePath,
    getSkillRegistrySummary,
    hasSkill,
    listSkills,
    normalizeSkillName,
    readSkillTemplate,
    refreshSkillRegistry,
    renderSkillPrompt,
    resolveSkillsDirectory
};
