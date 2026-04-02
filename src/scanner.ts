import fs from 'fs';
import path from 'path';

interface TreeEntry {
    isDirectory: boolean;
    name: string;
}

function safeReadTreeEntries(dirPath: string): TreeEntry[] {
    try {
        const dirents = fs.readdirSync(dirPath, { withFileTypes: true });
        return dirents.flatMap((dirent) => {
            if (dirent.isSymbolicLink()) {
                const fullPath = path.join(dirPath, dirent.name);

                try {
                    const stat = fs.statSync(fullPath);
                    return [{
                        name: dirent.name,
                        isDirectory: stat.isDirectory(),
                    }];
                } catch {
                    return [];
                }
            }

            return [{
                name: dirent.name,
                isDirectory: dirent.isDirectory(),
            }];
        });
    } catch {
        return [];
    }
}

// Keep the tree shallow to reduce prompt size sent to the model.
export function getProjectTree(dirPath: string, prefix: string = '', currentDepth: number = 0, maxDepth: number = 2): string {
    let tree = '';
    if (!fs.existsSync(dirPath)) return tree;

    if (currentDepth > maxDepth) {
        return `${prefix}└── ... (más archivos. Usa 'ls' o 'search_project' para explorar aquí)\n`;
    }

    const ignoreDirs = ['node_modules', '.git', 'assets', 'dist', '.expo', 'workspaces', 'ios', 'android', 'web-build', 'scripts', '.github', 'components/__tests__'];
    const ignoreFiles = ['package-lock.json', 'yarn.lock', 'bun.lockb', 'babel.config.js', 'metro.config.js', 'app.json', 'eas.json', '.gitignore', '.env', '.env.example'];
    const entries = safeReadTreeEntries(dirPath)
        .filter((entry) => entry.isDirectory ? !ignoreDirs.includes(entry.name) : !ignoreFiles.includes(entry.name) && !entry.name.startsWith('.'));

    // Sort directories first to produce a predictable, human-readable tree.
    entries.sort((a, b) => {
        const aIsDir = a.isDirectory;
        const bIsDir = b.isDirectory;
        if (aIsDir && !bIsDir) return -1;
        if (!aIsDir && bIsDir) return 1;
        return a.name.localeCompare(b.name);
    });

    for (let i = 0; i < entries.length; i++) {
        const entry = entries[i];
        const fullPath = path.join(dirPath, entry.name);
        const isLast = i === entries.length - 1;

        if (entry.isDirectory) {
            tree += `${prefix}${isLast ? '└── ' : '├── '}${entry.name}/\n`;
            tree += getProjectTree(fullPath, prefix + (isLast ? '    ' : '│   '), currentDepth + 1, maxDepth);
        } else {
            tree += `${prefix}${isLast ? '└── ' : '├── '}${entry.name}\n`;
        }
    }
    return tree;
}

// Accept both hidden and non-hidden UnityRC variants.
export function getProjectMemory(repoPath: string): string | null {
    const possibleNames = [
        '.unityrc.md', 
        'unityrc.md', 
        '.unityrc.md.txt', 
        'unityrc.md.txt'
    ];
    
    for (const name of possibleNames) {
        const memoryPath = path.join(repoPath, name);
        if (fs.existsSync(memoryPath)) {
            console.log(`🧠 Memoria de proyecto detectada y cargada desde: ${name}`);
            return fs.readFileSync(memoryPath, 'utf8');
        }
    }
    
    console.log(`⚠️ No se encontró memoria de proyecto en la raíz de: ${repoPath}`);
    return null;
}
