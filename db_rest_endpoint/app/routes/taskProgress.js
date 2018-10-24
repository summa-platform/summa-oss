/* eslint no-console: [2, { allow: ["log", "warn", "error", "assert"] }] */
import { Router } from 'express';
import Ajv from 'ajv';
import _ from 'underscore';
import { reportError, formatValidationErrors } from '../common/errorReporting.js';

const ajv = new Ajv({
  allErrors: true,
  verbose: true,
  jsonPointers: true,
  errorDataPath: 'property',
  v5: true,
});

const progressReportSchema = {
  title: 'task progress schema',
  type: 'object',
  required: [
    'taskMetadata',
  ],
  additionalProperties: true,
  properties: {
    taskMetadata: {
      type: 'object',
      required: [
        'tableName',
        'itemId',
        'resultFieldName',
      ],
      additionalProperties: true,
    },
  },
};

const validateProgressReport = ajv.compile(progressReportSchema);

export default (r, topLevelPath) => {
  const router = new Router();

  router.post('/', (request, response, next) => {
    // console.log('save progress report');
    const rawRequestContent = request.body;

    const failedToCreateDbError = (dbErr) => {
      reportError(response, {
        httpStatusCode: 500,
        message: 'Failed to create progress report',
        description: dbErr,
      });
      next();
    };

    if (!validateProgressReport(rawRequestContent)) {
      reportError(response, {
        httpStatusCode: 422, // 422 - Unprocessable Entity
        message: 'Validation Failed',
        errors: formatValidationErrors(validateProgressReport.errors),
      });
      next();
    } else {
      const { taskMetadata: { tableName, itemId, resultFieldName } } = rawRequestContent;
      r.table('progressReports')
        .insert({
          tableName,
          itemId,
          resultFieldName,
          timeAdded: r.now(),
          reportData: rawRequestContent,
        }, { durability: 'soft' })
        .run()
        .then(() => {
          response.status(200).end();
        })
        .error(failedToCreateDbError);
    }
  });

  return router;
};
