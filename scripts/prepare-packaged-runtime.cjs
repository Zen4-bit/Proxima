const fs = require('fs');
const path = require('path');

const projectRoot = path.resolve(__dirname, '..');
const outputRoot = path.join(projectRoot, 'build', 'packaged-runtime');
const outputNodeModulesRoot = path.join(outputRoot, 'node_modules');
const packageNamePathCache = new Map();
const copiedPackages = new Map();
const packageConflicts = [];

function readJson(filePath) {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function removeIfExists(filePath) {
    fs.rmSync(filePath, { recursive: true, force: true });
}

function ensureDir(dirPath) {
    fs.mkdirSync(dirPath, { recursive: true });
}

function copyDirectory(sourcePath, targetPath) {
    fs.cpSync(sourcePath, targetPath, {
        recursive: true,
        dereference: true,
        filter: (candidatePath) => path.basename(candidatePath) !== 'node_modules'
    });
}

function packageNameToPath(packageName) {
    if (!packageNamePathCache.has(packageName)) {
        packageNamePathCache.set(packageName, packageName.split('/').join(path.sep));
    }
    return packageNamePathCache.get(packageName);
}

function stripPackageNameFromPath(filePath, packageName) {
    const normalizedFilePath = path.normalize(filePath);
    const normalizedPackagePath = packageNameToPath(packageName);
    const suffix = `${path.sep}${normalizedPackagePath}`;

    if (!normalizedFilePath.endsWith(suffix)) {
        throw new Error(`Could not determine install root for ${packageName} from ${filePath}`);
    }

    return normalizedFilePath.slice(0, -suffix.length);
}

function resolveSourceEntryPath(packageName, installRoot) {
    const sourceEntryPath = path.join(installRoot, packageNameToPath(packageName));
    if (!fs.existsSync(sourceEntryPath)) {
        throw new Error(`Missing installed dependency ${packageName} in ${installRoot}`);
    }
    return sourceEntryPath;
}

function listChildDependencyNames(sourcePackageJson, installRoot) {
    const dependencyNames = new Set([
        ...Object.keys(sourcePackageJson.dependencies || {}),
        ...Object.keys(sourcePackageJson.optionalDependencies || {})
    ]);

    for (const dependencyName of Object.keys(sourcePackageJson.peerDependencies || {})) {
        const peerPath = path.join(installRoot, packageNameToPath(dependencyName));
        if (fs.existsSync(peerPath)) {
            dependencyNames.add(dependencyName);
        }
    }

    return Array.from(dependencyNames).sort((a, b) => a.localeCompare(b));
}

function copyInstalledPackage(packageName, sourceInstallRoot) {
    const sourceEntryPath = resolveSourceEntryPath(packageName, sourceInstallRoot);
    const sourcePackageDir = fs.realpathSync(sourceEntryPath);
    const sourcePackageJson = readJson(path.join(sourcePackageDir, 'package.json'));
    const existingPackage = copiedPackages.get(sourcePackageJson.name);

    if (existingPackage) {
        if (existingPackage.sourcePackageDir !== sourcePackageDir) {
            packageConflicts.push({
                name: sourcePackageJson.name,
                keptVersion: existingPackage.version,
                skippedVersion: sourcePackageJson.version,
                keptPath: existingPackage.sourcePackageDir,
                skippedPath: sourcePackageDir
            });
        }
        return;
    }

    copiedPackages.set(sourcePackageJson.name, {
        sourcePackageDir,
        version: sourcePackageJson.version
    });

    const destinationPackageDir = path.join(outputNodeModulesRoot, packageNameToPath(sourcePackageJson.name));

    ensureDir(path.dirname(destinationPackageDir));
    copyDirectory(sourcePackageDir, destinationPackageDir);

    const sourcePackageInstallRoot = stripPackageNameFromPath(sourcePackageDir, sourcePackageJson.name);

    for (const dependencyName of listChildDependencyNames(sourcePackageJson, sourcePackageInstallRoot)) {
        copyInstalledPackage(dependencyName, sourcePackageInstallRoot);
    }
}

function prepareRuntimeDirectory() {
    const rootPackageJson = readJson(path.join(projectRoot, 'package.json'));
    const rootNodeModules = path.join(projectRoot, 'node_modules');

    removeIfExists(outputRoot);
    ensureDir(outputRoot);
    ensureDir(outputNodeModulesRoot);

    copyDirectory(path.join(projectRoot, 'src'), path.join(outputRoot, 'src'));

    const skillsSourceDir = path.join(projectRoot, 'skills');
    const skillsOutputDir = path.join(outputRoot, 'skills');
    if (fs.existsSync(skillsSourceDir)) {
        copyDirectory(skillsSourceDir, skillsOutputDir);
    } else {
        ensureDir(skillsOutputDir);
    }

    for (const dependencyName of Object.keys(rootPackageJson.dependencies || {}).sort((a, b) => a.localeCompare(b))) {
        copyInstalledPackage(dependencyName, rootNodeModules);
    }

    fs.writeFileSync(
        path.join(outputRoot, 'runtime-version.json'),
        JSON.stringify({ version: rootPackageJson.version }, null, 2)
    );

    if (packageConflicts.length > 0) {
        console.warn('[build] Packaged runtime hoisted conflicting package versions:');
        for (const conflict of packageConflicts) {
            console.warn(
                `[build] ${conflict.name}: kept ${conflict.keptVersion}, skipped ${conflict.skippedVersion}`
            );
        }
    }
}

prepareRuntimeDirectory();
console.log(`[build] Prepared packaged runtime in ${outputRoot}`);
