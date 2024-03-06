// const config = import('./netlifyConfig');
// const AdmZip = import('adm-zip');
// const fs = import('fs');

import config from './netlifyConfig.js';
import fs from 'fs';
import AdmZip from 'adm-zip';

async function createZipArchive(directory) {
    //Create 404.html
    fs.copyFile(directory + '/index.html', directory + '/404.html', (err) => {
        if (err) throw err;
    });
    const zip = new AdmZip();
    const outputFile = directory + '.zip';
    zip.addLocalFolder('./' + directory);
    zip.writeZip(outputFile);
    console.log(`Created ${outputFile} successfully`);
}

async function cleanUp(fileName) {
    try {
        //Remove the zip file
        fs.unlinkSync(fileName);
        //Remove the dist folder
        fs.rmdir('./dist', { recursive: true }, (err) => {
            if (err) {
                return console.log('error occurred in deleting directory', err);
            }
        });
        console.log('Cleaned up files and folders');
    } catch (error) {
        console.log(error);
    }
}
async function deployZip(fileName, siteName, token) {
    fetch('https://api.netlify.com/api/v1/sites/' + siteName + '/deploys', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/zip',
            'User-Agent': 'MyApp (brandon@untether.co.za)',
            Authorization: token,
        },
        body: new File([fs.readFileSync(fileName)], fileName),
    })
        .then((response) => response.json())
        .then((data) => console.log(data.id))
        .then(() => cleanUp(fileName));
}

for (var i = 0; i < process.argv.length; i++) {
    switch (process.argv[i]) {
        case 'dev':
            createZipArchive('dist').then(
                deployZip(
                    'dist.zip',
                    config.dev.NETLIFY_SITE_NAME,
                    config.dev.NETLIFY_BEARER_TOKEN,
                ),
            );
            break;
        case 'prod':
            createZipArchive('dist').then(
                deployZip(
                    'dist.zip',
                    config.prod.NETLIFY_SITE_NAME,
                    config.prod.NETLIFY_BEARER_TOKEN,
                ),
            );
            break;
    }
}
