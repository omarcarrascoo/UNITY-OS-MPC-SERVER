import fs from 'fs';
import path from 'path';

export function getProjectTree(dirPath: string, prefix: string = ''): string {
    let tree = '';
    if (!fs.existsSync(dirPath)) return tree;

    const items = fs.readdirSync(dirPath);
    
    const ignoreDirs = ['node_modules', '.git', 'assets', 'dist', '.expo', 'workspaces', 'ios', 'android', 'web-build', 'scripts', '.github', 'components/__tests__'];
    const ignoreFiles = ['package-lock.json', 'yarn.lock', 'bun.lockb', 'babel.config.js', 'metro.config.js', 'app.json', 'eas.json', '.gitignore', '.env', '.env.example'];

    items.sort((a, b) => {
        const aIsDir = fs.statSync(path.join(dirPath, a)).isDirectory();
        const bIsDir = fs.statSync(path.join(dirPath, b)).isDirectory();
        if (aIsDir && !bIsDir) return -1;
        if (!aIsDir && bIsDir) return 1;
        return a.localeCompare(b);
    });

    for (let i = 0; i < items.length; i++) {
        const item = items[i];
        const fullPath = path.join(dirPath, item);
        const isLast = i === items.length - 1;
        const stat = fs.statSync(fullPath);

        if (stat.isDirectory()) {
            if (!ignoreDirs.includes(item)) {
                tree += `${prefix}${isLast ? '└── ' : '├── '}${item}/\n`;
                tree += getProjectTree(fullPath, prefix + (isLast ? '    ' : '│   '));
            }
        } else {
            if (!ignoreFiles.includes(item) && !item.startsWith('.')) {
                tree += `${prefix}${isLast ? '└── ' : '├── '}${item}\n`;
            }
        }
    }
    return tree;
}