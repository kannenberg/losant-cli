#!/usr/bin/env node
const program = require('commander');
const c = require('chalk');
const losant = require('losant-rest');
const fs = require('fs');
const path = require('path');
const minimatch = require('minimatch');
const mkdirp = require('mkdirp');
const { spawn } = require('child_process');
const {
  loadConfig,
  loadLocalMeta,
  saveLocalMeta,
  getLocalStatus,
  getRemoteStatus,
  checksum,
  log,
  logProcessing,
  logResult,
  logError
} = require('../lib/utils');

program
  .description('Manage Losant Experience Views from the command line');

program
  .command('download [pattern]')
  .option('-f, --force', 'force all changes by ignoring modification checking')
  .option('-c, --config <file>', 'config file to run the command with. (default: "losant.yml")')
  .option('-d, --dir <dir>', 'directory to run the command in. (default: current directory)')
  .option('--dry-run', 'display actions but do not perform them')
  .action(async (pattern, command) => {
    if (command.dir) {
      process.chdir(command.dir);
    }
    const config = loadConfig(command.config);
    const api = losant.createClient({ accessToken: config.apiToken });
    const meta = loadLocalMeta('views') || {};
    let views;
    try {
      views = await api.experienceViews.get({ applicationId: config.applicationId });
    } catch (e) {
      await saveLocalMeta('views', meta);
      return logError(e);
    }
    // const results = [];
    let items = views.items;
    // const itemsSkipped = false;
    // filter out views that don't match file pattern
    if (pattern) {
      items = items.filter((view) => {
        if (minimatch(view.name, pattern)) {
          return true;
        }
        return false;
      });
    }
    // map views to id
    const viewsById = {};
    items.forEach((item) => {
      viewsById[item.id] = item;
    });
    // grab the local status and map to ids
    const localStatus = getLocalStatus('views', '/**/*.hbs', 'views');
    const localStatusById = {};
    const newLocalFiles = new Set();
    localStatus.forEach((item) => {
      if (item.id) {
        localStatusById[item.id] = item;
      } else {
        newLocalFiles.add(item.file);
      }
    });
    // iterate over remote status and perform the appropriate action
    const remoteStatus = getRemoteStatus('views', items, 'views/${viewType}s/${name}.hbs', 'body'); // eslint-disable-line no-template-curly-in-string
    if (command.dryRun) {
      log('DRY RUN');
    }
    remoteStatus.forEach((item) => {
      logProcessing(item.file);
      // if forcing the update ignore conflicts and local modifications
      if (!command.force) {
        if (item.status === 'unmodified') {
          logResult('unmodified', item.file);
          return;
        }
        if ((localStatusById[item.id] && localStatusById[item.id].status !== 'unmodified') || newLocalFiles.has(item.file)) {
          logResult('conflict', item.file, 'red');
          return;
        }
      }
      if (item.status === 'deleted') {
        if (!command.dryRun) {
          if (fs.existsSync(item.file)) {
            fs.unlinkSync(item.file);
          }
          delete meta[item.file];
        }
        logResult('deleted', item.file, 'yellow');
      } else {
        if (!command.dryRun) {
          const view = viewsById[item.id];
          const mtime = new Date(item.remoteModTime);
          mkdirp.sync(path.dirname(item.file));
          fs.writeFileSync(item.file, view.body);
          meta[item.file] = {
            id: item.id,
            md5: checksum(view.body),
            remoteTime: mtime.getTime(),
            localTime: new Date().getTime()
          };
        }
        logResult('downloaded', item.file, 'green');
      }
    });
    try {
      await saveLocalMeta('views', meta);
    } catch (err) {
      logError(err);
    }
  });

program
  .command('upload [pattern]')
  .option('-f, --force', 'force all changes by ignoring modification checking')
  .option('-c, --config <file>', 'config file to run the command with. (default: "losant.yml")')
  .option('-d, --dir <dir>', 'directory to run the command in. (default: current directory)')
  .option('--dry-run', 'display actions but do not perform them')
  .action(async (pattern, command) => {
    if (command.dir) {
      process.chdir(command.dir);
    }
    const config = loadConfig(command.config);
    const api = losant.createClient({ accessToken: config.apiToken });
    const meta = loadLocalMeta('views') || {};
    try {
      const views = await api.experienceViews.get({ applicationId: config.applicationId });
      const items = views.items;
      // grab remote status and map to file
      const remoteStatus = getRemoteStatus('views', items, 'views/${viewType}s/${name}.hbs', 'body'); // eslint-disable-line no-template-curly-in-string
      const remoteStatusById = {};
      remoteStatus.forEach((item) => {
        if (item.id) {
          remoteStatusById[item.id] = item;
        }
      });
      // iterate over local status and perform the appropriate action
      const localStatus = getLocalStatus('views', `/${pattern || '**/*'}.hbs`, 'views');
      if (command.dryRun) {
        log('DRY RUN');
      }
      return Promise.all(localStatus.map((item) => {
        logProcessing(item.file);
        const pathParts = item.file.split(path.sep);
        // if forcing the update ignore conflicts and remote modifications
        if (!command.force) {
          if (item.status === 'unmodified') {
            logResult('unmodified', item.file);
            return;
          }
          if ((remoteStatusById[item.id] && remoteStatusById[item.id].status !== 'unmodified')) {
            logResult('conflict', item.file, 'red');
            return Promise.resolve();
          }
        }
        if (item.status === 'deleted') {
          if (!command.dryRun) {
            return api.experienceView
              .delete({ applicationId: config.applicationId,  experienceViewId: item.id })
              .then(() => {
                delete meta[item.file];
                logResult('deleted', item.file, 'yellow');
                return Promise.resolve();
              });
          }
          logResult('deleted', item.file, 'yellow');
          return Promise.resolve();
        } else {
          if (!command.dryRun) {
            let action;
            const body = fs.readFileSync(item.file);
            if (item.id) {
              action = api.experienceView
                .patch({
                  applicationId: config.applicationId,
                  experienceViewId: item.id,
                  experienceView:  { body: body.toString() }
                });
            } else {
              action = api.experienceViews
                .post({
                  applicationId: config.applicationId,
                  experienceView: {
                    viewType: pathParts[1].slice(0, -1),
                    name: item.name,
                    body: body.toString()
                  }
                });
            }
            return action.then((view) => {
              const mtime = new Date(view.lastUpdated);
              // mkdirp.sync(path.dirname(item.file))
              // fs.writeFileSync(item.file, view.body)
              meta[item.file] = {
                id: view.id,
                md5: checksum(view.body),
                remoteTime: mtime.getTime(),
                localTime: item.localModTime * 1000
              };
              logResult('uploaded', item.file, 'green');
              return Promise.resolve();
            });
          }
          logResult('uploaded', item.file, 'green');
          return Promise.resolve();
        }
      }));
      await saveLocalMeta('views', meta);
    } catch (error) {
      try { saveLocalMeta('views', meta); } catch (err) { logError(err); }
      logError(error);
    }
  });

program
  .command('status')
  .option('-c, --config <file>', 'config file to run the command with')
  .option('-d, --dir <dir>', 'directory to run the command in. (default current directory)')
  .option('-r, --remote', 'show remote file status')
  .action(async (command) => {
    if (command.dir) {
      process.chdir(command.dir);
    }
    const config = loadConfig(command.config);
    const api = losant.createClient({ accessToken: config.apiToken });
    try {
      const views = await api.experienceViews.get({ applicationId: config.applicationId });
      if (command.remote) {
        const remoteStatus = getRemoteStatus('views', views.items, 'views/${viewType}s/${name}.hbs', 'body'); // eslint-disable-line no-template-curly-in-string
        if (remoteStatus.length === 0) {
          log('No remote views found');
        }
        remoteStatus.forEach((item) => {
          if (item.status === 'added') { logResult(item.status, item.file, 'green'); } else if (item.status === 'modified') { logResult(item.status, item.file, 'yellow'); } else if (item.status === 'deleted') { logResult(item.status, item.file, 'red'); } else { logResult(item.status, item.file); }
        });
      } else {
        const localStatus = getLocalStatus('views', '/**/*.hbs', 'views');
        if (localStatus.length === 0) {
          log('No local views found');
        }
        localStatus.forEach((item) => {
          if (item.status === 'added') { logResult(item.status, item.file, 'green'); } else if (item.status === 'modified') { logResult(item.status, item.file, 'yellow'); } else if (item.status === 'deleted') { logResult(item.status, item.file, 'red'); } else { logResult(item.status, item.file); }
        });
      }
      
    } catch (err) {
      logError(err);
    }
  });

program
  .command('watch')
  .option('-c, --config <file>', 'config file to run the command with')
  .option('-d, --dir <dir>', 'directory to run the command in. (default current directory)')
  .action((command) => {
    if (command.dir) {
      process.chdir(command.dir);
    }
    fs.watch('views', { recursive: true }, (eventType, filename) => {
      if (eventType === 'change') {
        if (filename) {
          const cmd = process.argv[0];
          const args = process.argv.slice(1);
          args[1] = 'upload';
          args.push(`${filename.slice(0, -4)}`);
          const options = {
            cwd: process.cwd(),
            stdio: [process.stdin, process.stdout, 'pipe']
          };
          const upload = spawn(cmd, args, options);
          upload.on('error', (err) => {
            log(`${c.red('Error')} ${err.message}`);
            process.exit(1);
          });
        }
      }
    });
  });

program.on('--help', () => {
  log('');
  log('  Examples:');
  log('');
  log('    Download all views');
  log('     $ losant views download \n');
  log('    Download component views');
  log('     $ losant views download components/* \n');
  log('    Force a download of all views overwriting local modifications');
  log('     $ losant views download -f \n');
  log('    Check local modification status');
  log('     $ losant views status \n');
  log('    Check remote modification status');
  log('     $ losant views status -r \n');
  log('    Upload all view');
  log('     $ losant views upload \n');
  log('    Upload component view');
  log('     $ losant views upload components/* \n');
  log('    Force an upload of all views overwriting remote modifications');
  log('     $ losant views upload -f \n');
  log('');
});

program.parse(process.argv);
