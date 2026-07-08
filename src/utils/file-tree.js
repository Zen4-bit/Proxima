// Proxima — File Tree Utilities.
// Builds hierarchical ASCII trees and reports file counts for directory trees.

import path from 'path';

function createTreeNode(name, isDirectory) {
    return { name, children: [], isDirectory };
}

export function generateFileTree(files) {
    const root = createTreeNode('root', true);

    for (const file of files) {
        const parts = file.split(/[/\\]/);
        let current = root;

        for (let i = 0; i < parts.length; i++) {
            const part = parts[i];
            const isLast = i === parts.length - 1;

            let child = current.children.find(c => c.name === part);
            if (!child) {
                child = createTreeNode(part, !isLast);
                current.children.push(child);
            }
            current = child;
        }
    }

    return root;
}

function sortTreeNodes(node) {
    node.children.sort((a, b) => {
        if (a.isDirectory === b.isDirectory) {
            return a.name.localeCompare(b.name);
        }
        return a.isDirectory ? -1 : 1;
    });

    for (const child of node.children) {
        sortTreeNodes(child);
    }
}

export function treeToString(node, prefix = '', isRoot = true) {
    if (isRoot) {
        sortTreeNodes(node);
    }

    let result = '';
    for (const child of node.children) {
        result += `${prefix}${child.name}${child.isDirectory ? '/' : ''}\n`;
        if (child.isDirectory) {
            result += treeToString(child, `${prefix}  `, false);
        }
    }
    return result;
}

export function treeToStringWithLineCounts(node, lineCounts, prefix = '', currentPath = '', isRoot = true) {
    if (isRoot) {
        sortTreeNodes(node);
    }

    let result = '';
    for (const child of node.children) {
        const childPath = currentPath ? `${currentPath}/${child.name}` : child.name;

        if (child.isDirectory) {
            result += `${prefix}${child.name}/\n`;
            result += treeToStringWithLineCounts(child, lineCounts, `${prefix}  `, childPath, false);
        } else {
            const lineCount = lineCounts[childPath];
            const suffix = lineCount !== undefined ? ` (${lineCount} lines)` : '';
            result += `${prefix}${child.name}${suffix}\n`;
        }
    }
    return result;
}

export function generateTreeString(files) {
    const tree = generateFileTree(files);
    return treeToString(tree).trim();
}

export function generateTreeStringWithLineCounts(files, lineCounts) {
    const tree = generateFileTree(files);
    return treeToStringWithLineCounts(tree, lineCounts).trim();
}

export function getTreeStats(node) {
    let files = 0;
    let directories = 0;

    for (const child of node.children) {
        if (child.isDirectory) {
            directories++;
            const childStats = getTreeStats(child);
            files += childStats.files;
            directories += childStats.directories;
        } else {
            files++;
        }
    }

    return { files, directories };
}
