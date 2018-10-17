const { readFile } = require('fs-extra');
const path = require('path');
const FormData = require('form-data');
const mimeTypes = require('mime-types');
const  { files: { apiType, commandType, localStatusParams, remoteStatusParams } } = require('../../lib/constants');

const uploadConflictDetect = (localStat, remoteStat) => {
  return remoteStat && remoteStat.status !== 'unmodified';
  // TODO all these tests...
  // 1. remoteStat does not exist , new file added fere
  // 2. remoteStat does exist and it does not match local stat
  // 3. remoteStat does not exist but local stat does exist meaning it was previously deleted.
  // return remoteStat && stat.s3etag !== remoteStat.md5;
};

const getDeleteQuery = (item, config) => {
  return { applicationId: config.applicationId,  fileId: item.id };
};
const getPatchData = (item, config) => {
  return {
    applicationId: config.applicationId,
    fileId: item.id,
    file:  {
      fileSize: item.size
    }
  };
};

const getPostData = (item, config) => {
  const pathParts = path.parse(item.file);
  return {
    applicationId: config.applicationId,
    file: {
      name: item.name,
      parentDirectory: pathParts.length > 1 ? pathParts.slice(1, -1).join(path.sep) : '/',
      type: 'file',
      fileSize: item.size,
      contentType: mimeTypes.lookup(item.file)
    }
  };
};

const postUpsertUpdateMeta = async (result, meta, item) => {
  const body = await readFile(item.file);
  let s3etag;
  await new Promise((resolve, reject) => {
    const fd = new FormData();
    Object.keys(result.upload.fields).forEach((key) => {
      if (key !== 'bucket') {
        fd.append(key, result.upload.fields[key]);
      }
    });
    fd.append('file', body);
    fd.submit(result.upload.url, (err, res) => {
      if (err) { return reject(err); }
      s3etag = (res.headers.etag).replace(/"/g, '');
      res.resume();
      res.on('end', () => { return resolve(); });
    });
  });
  const mtime = new Date(result.lastUpdated);
  meta[item.file] = {
    id: result.id,
    md5: s3etag,
    remoteTime: mtime.getTime(),
    localTime: item.localModTime * 1000
  };
};
const params = {
  apiType,
  commandType,
  localStatusParams,
  remoteStatusParams,
  isConflictDetected: uploadConflictDetect,
  getDeleteQuery,
  getPatchData,
  getPostData,
  postUpsertUpdateMeta
};
module.exports = (program) => {
  require('../utils/upload')(program,  params);
};