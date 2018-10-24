import debug from 'debug';

const stepType = process.env.STEP_TYPE.toLowerCase();

const integrationDebug = debug(`integration:${stepType}`);

function getTaskDebugFn(taskPath, optionalExtraLevels) {
  const extraLevels = optionalExtraLevels ? `:${optionalExtraLevels}` : '';
  const taskNameMatch = taskPath.match(/(?:(\w+)\/step_specs$)|(?:(\w+)$)/);
  const taskName = taskNameMatch[1] || taskNameMatch[2];
  return debug(`integration:${stepType}:${taskName}${extraLevels}`);
}

module.exports = {
  integrationDebug, getTaskDebugFn,
};
