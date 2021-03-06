const paginateRequest = require('./paginate-request');
const path   = require('path');
const inquirer = require('inquirer');
const {
  loadConfig,
  getStatus,
  loadLocalMeta,
  saveLocalMeta,
  checksum,
  logResult,
  logProcessing,
  logError,
  mapById,
  getComparativeStatus,
  plural,
  isValidExperienceOptions
} = require('./utils');
const {
  remove,
  writeFile,
  pathExists,
  ensureDir
} = require('fs-extra');
const { merge, values, isEmpty } = require('omnibelt');
const allSettledSerial = require('./all-settled-serial-p');
const { rollbarLog } = require('./rollbar');

const getDownloader = ({
  apiType, commandType, localStatusParams, remoteStatusParams, getData, extraQuery
}) => {
  const download = async (pattern, command = {}, loadedConfig) => {
    let didDownload = false;
    const { apiToken, applicationId, api } = loadedConfig ? loadedConfig : await loadConfig();
    if (!apiToken || !applicationId) { return; }
    if (commandType === 'experience' && !isValidExperienceOptions(command)) { return; }
    const meta = await loadLocalMeta(commandType) || {};
    let items;
    try {
      let query = { applicationId };
      if (extraQuery) {
        query = merge(query, extraQuery);
      }
      items = await paginateRequest(api[apiType].get, query);
    } catch (e) {
      await saveLocalMeta(commandType, meta);
      return logError(e);
    }
    const itemsById = mapById(items);
    const { remoteStatusByFile, localStatusByFile } = await getStatus({
      commandType,
      items,
      remoteStatusParams,
      localStatusParams,
      pattern,
      type: command.type
    });

    if (command.dryRun) {
      logResult('DRY RUN');
    }
    if (isEmpty(remoteStatusByFile)) {
      if (!pattern) {
        return logResult('Missing', `No ${plural(commandType)} found to download.`, 'yellow');
      } else {
        return logResult('No Matches', `No ${plural(commandType)} found that match this pattern ${pattern}`, 'yellow');
      }
    }
    const downloadResults = await allSettledSerial(async (remoteStatus) => {
      logProcessing(remoteStatus.file);
      if (!command.force) {
        const localStatus = localStatusByFile[remoteStatus.file];
        const { conflict } = getComparativeStatus(localStatus, remoteStatus);
        if (conflict) {
          const { handleConflict } = await inquirer.prompt([{
            name: 'handleConflict',
            type: 'list',
            message: `A conflict has been dected in ${remoteStatus.file}, how do you want to handle this?`,
            choices: [
              { name: 'Do nothing, and resolve the conflict later.', value: null },
              { name: 'Overwrite with the remote data.', value: 'overwrite' },
              { name: 'Ignore the remote data.', value: 'local' }
            ]
          }]);
          if (!handleConflict) {
            return logResult('conflict', remoteStatus.file, 'redBright');
          }
          if (handleConflict === 'local') {
            if (remoteStatus.status !== 'deleted') {
              // faking that the local status and the remote status match so there is no conflict when uploading
              meta[remoteStatus.file] = {
                file: remoteStatus.file,
                id: remoteStatus.id,
                md5: remoteStatus.remoteMd5,
                remoteTime: remoteStatus.remoteModTime,
                localTime: Date.now()
              };
              return logResult('unmodified', remoteStatus.file);
            } else {
              // e.g. make the local a "new" state, since the remote file was deleted.
              delete meta[remoteStatus.file];
              return; // purposefully not printing anything out
            }
          }
        }
      }
      if (remoteStatus.status === 'unmodified') {
        return logResult('unmodified', remoteStatus.file);
      }
      if (remoteStatus.status === 'deleted') {
        if (!command.dryRun) {
          try {
            if (await pathExists(remoteStatus.file)) {
              await remove(remoteStatus.file);
            }
          } catch (e) {
            return logError(`An Error occurred when trying to delete file ${remoteStatus.file} with the message ${e.message}`);
          }
          delete meta[remoteStatus.file];
        }
        return logResult('deleted', remoteStatus.file, 'yellow');
      }
      if (!command.dryRun) {
        await ensureDir(path.dirname(remoteStatus.file));
        let data;
        try {
          data = await getData(itemsById[remoteStatus.id], api);
        } catch (e) {
          return logError(`An Error occurred when trying to download data for file ${remoteStatus.file} with the message ${e.message}`);
        }
        try {
          await writeFile(remoteStatus.file, data);
        } catch (e) {
          return logError(`An Error occurred when trying to write the file ${remoteStatus.file} with the message ${e.message}`);
        }
        meta[remoteStatus.file] = {
          file: remoteStatus.file,
          id: remoteStatus.id, // can probably remove
          md5: checksum(data),
          remoteTime: remoteStatus.remoteModTime,
          localTime: Date.now()
        };
      }
      logResult('downloaded', remoteStatus.file, 'green');
      didDownload = true;
    }, values(remoteStatusByFile));
    downloadResults.forEach((result) => {
      // this should only occur on unhandled rejections any api error should have already logged and resolved the promise
      if (result.state !== 'fulfilled') {
        rollbarLog(result.reason);
        logError(result.reason);
      }
    });
    if (!command.dryRun) {
      await saveLocalMeta(commandType, meta);
    }
    return didDownload;
  };
  return download;
};

module.exports = getDownloader;
