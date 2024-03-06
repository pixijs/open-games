const config = require('./netlifyConfig');
const AdmZip = require("adm-zip");
const fs = require('fs');
const crypto = require("crypto")
const path = require("path")

//Note this doesnt work. It breaks on the final step(line 56) when the files are being uploaded with auth error. Ref: https://www.netlify.com/blog/2020/09/24/how-to-deploy-a-simple-site-using-postman-and-the-netlify-api/

function createDigest(inputString) {
    let algorithm = "sha1"
    let digest = crypto.createHash(algorithm).update(inputString).digest("base64")
    
    return digest
    }
    
    
 const getAllFiles = function(dirPath, arrayOfFiles) {
  files = fs.readdirSync(dirPath)
  arrayOfFiles = arrayOfFiles || []
  files.forEach(function(file) {
    if (fs.statSync(dirPath + "/" + file).isDirectory()) {
      arrayOfFiles = getAllFiles(dirPath + "/" + file, arrayOfFiles)
    } else {
      arrayOfFiles.push(path.join(__dirname, dirPath, "/", file))
    }
  })
  return arrayOfFiles
}


const filesWithDigest = function(){
    let allFiles = getAllFiles("dist")
    let arrayOfFiles = {}

    allFiles.forEach(filePath => {
    let digest = createDigest(filePath)
    arrayOfFiles[filePath] = (digest)
   
})
return arrayOfFiles
};

    
function uploadFile(deployId,filePath){
  let stats = fs.statSync(filePath);
  let fileSizeInBytes = stats.size;
  console.log('https://api.netlify.com/api/v1/deploys/'+deployId+'/files/'+filePath.substring(1))
  fetch('https://api.netlify.com/api/v1/deploys/'+deployId+'/files/'+filePath, {
  method: 'PUT',
  headers: {
    'User-Agent': 'MyApp (brandon@untether.co.za)',
    'Authorization': config.dev.NETLIFY_BEARER_TOKEN,
    "Content-length": fileSizeInBytes
  },
  body: fs.readFileSync(filePath)
}).then(response => response.json())}

fetch('https://api.netlify.com/api/v1/sites/untetherdev.netlify.app/deploys', {
  method: 'POST',
  headers: {
    'User-Agent': 'MyApp (brandon@untether.co.za)',
    'Authorization': config.dev.NETLIFY_BEARER_TOKEN
  },
  body: {
    "files": filesWithDigest()}
}).then(response => response.json())
.then(function(deploy) {
  console.log('ID is '+deploy.id+' Files '+getAllFiles("dist"))
  getAllFiles("dist").forEach(filePath =>{
    console.log(filePath)
    uploadFile(deploy.id,filePath)})
})