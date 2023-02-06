import fs from 'fs';

function clean() {
    fs.rmSync('public/assets/', { force: true, recursive: true });
    fs.rmSync('dist/', { force: true, recursive: true });
    fs.rmSync('.assetpack/', { force: true, recursive: true });
}

const commands = {
    clean
}

if (process.argv[2]) {
    commands[process.argv[2]]();
}


