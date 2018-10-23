const { options } = require('../../lib/constants');
const { capitalize } = require('omnibelt');
module.exports = (nameOfCommand, program) => {
  program
    .command('watch')
    .option(...options.directory)
    .option(...options.config)
    .action(require('../../lib/watch-files')(nameOfCommand));

  return {
    helpLines: [
      `Watch your ${capitalize(nameOfCommand)} while you make changes and have them automatically uploaded`,
      `$ losant ${nameOfCommand} watch`
    ]
  };
};
