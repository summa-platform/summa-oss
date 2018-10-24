/* eslint no-console: [2, { allow: ["log", "warn", "error", "assert"] }] */
import _ from 'underscore';
import { reportError, formatValidationErrors } from './errorReporting.js';


export function createPatchDescriptionSchema(changablePropertyList, itemSchema) {
  const schema = {
    title: 'Patch Update Schema',
    definitions: {
      patchItem: {
        title: 'Patch Update Schema',
        type: 'object',
        required: ['updateType', 'status', 'source'],
        additionalProperties: false,
        properties: {
          updateType: {
            description: 'Update type',
            type: 'string',
            enum: ['set', 'errorReport'], // , 'append', 'concat', 'delete'],
          },
          status: {
            description: 'Status of the property value',
            type: 'string',
            enum: ['final', 'streaming', 'error'],
          },
          value: {
            description: 'The value to use in the update',
            type: 'object',
            // at least one property must be present
            // it must match the schema
            anyOf: _.map(changablePropertyList, property => ({
              required: [property],
              additionalProperties: false,
              properties: _.pick(itemSchema.properties, property),
            })),
          },
          source: {
            description: 'Who sent the update',
            type: 'string',
          },
          error: {
            description: 'Description of the error',
          },
          errorFieldName: {
            type: 'string',
            enum: _.keys(itemSchema.properties),
          },
          dependencyFieldsHash: {
            description: 'hash of the dependency fields',
            type: 'string',
          },
          dependencyFields: {
            description: 'array with names of the dependency fields',
            type: 'array',
            items: {
              type: 'string',
            },
          },
        },
        switch: [
          {
            if: { properties: { status: { constant: 'error' } } },
            then: { required: ['error', 'errorFieldName'] },
            continue: true,
          },
          {
            if: { required: ['error'] },
            then: {
              required: ['errorFieldName'],
              properties: { status: { constant: 'error' } } },
          },
        ],
      },
    },
    type: 'object',
    required: ['patches'],
    additionalProperties: false,
    properties: {
      patches: {
        description: 'List of updates',
        type: 'array',
        items: { $ref: '#/definitions/patchItem' },
      },
    },
  };

  return schema;
}

// the structure of the stored data fields
// {
//   fieldName: value
//   summaPlatformProcessingMetadata: {
//     fieldName: {
//       source: stringSourceOfTheValue,
//       status: stringStatusOfTheValue(final | streaming | error),
//       updateTime: "2016-08-30T07:05:21.707Z",
//       error: if status is error than should contain the error
//   }
// }
export function makeDataFieldValue(r, source, status, value, error) {
  return {
    source,
    status,
    updateTime: r.now(),
    error,
    valueHash: (error || _.isUndefined(value))
               ? r.uuid(r.expr(null).toJsonString())
               : r.uuid(r.expr(value).toJsonString()),
  };
}

export function handlePatchRequest(validatePatchDescription, r, topLevelPath,
                                   tableName,
                                   request, response, next) {
  const rowId = request.params.id;

  const patchDescription = request.body;

  // console.log(JSON.stringify(patchDescription, null, 4));

  if (!validatePatchDescription(patchDescription)) {
    const errors = validatePatchDescription.errors;
    console.log('[INFERR] path validation failure', '\n' + JSON.stringify(errors, null, 4));
    reportError(response, {
      httpStatusCode: 422, // 422 - Unprocessable Entity
      message: 'Validation Failed',
      errors: formatValidationErrors(errors),
    });
  } else {
    // build the update query
    const updateQuery = {
      summaPlatformProcessingMetadata: {},
    };
    patchDescription.patches.forEach((patch) => {
      if (patch.updateType === 'set') {
        // console.log(patch);
        const property = patch.status !== 'error' ? _.keys(patch.value)[0] : patch.errorFieldName;
        updateQuery[property] = patch.status !== 'error' ? r.literal(patch.value[property]) : r.literal();
        updateQuery.summaPlatformProcessingMetadata[property] = r.literal({
          status: patch.status,
          source: patch.source,
          error: patch.error,
          updateTime: r.now(),
          dependencyFieldsHash: patch.dependencyFieldsHash || undefined,
          dependencyFields: patch.dependencyFields || undefined,
          valueHash: (patch.status !== 'error')
                      ? r.uuid(r.expr(patch.value[property]).toJsonString())
                      : r.uuid(r.expr(null).toJsonString()),
        });
      } else {
        console.error(`[ERR ] Unsupported patch type ${patch.updateType}`);
        reportError(response, {
          httpStatusCode: 422, // 422 - Unprocessable Entity
          message: 'Validation Failed',
          errors: formatValidationErrors(`[ERR ] Unsupported patch type ${patch.updateType}`),
        });
      }
    });


    r.table(tableName)
      .get(rowId)
      .replace((newsItem) => {
        // update only if the hashes aggree
        const metadata = newsItem('summaPlatformProcessingMetadata').default({});
        const hashChecks = _.chain(patchDescription.patches)
          // get pathes with dependency fields and hash
          .filter(patch => _.has(patch, 'dependencyFields') &&
                           _.has(patch, 'dependencyFieldsHash'))
          // r expression to check hash value
          .map(patch => (
            // NOTE – hash calculation needs to be the same as in
            //        /db_rest_endpoint/app/common/summaDBUpdate.js
            r.uuid(
              r.expr(_.sortBy(patch.dependencyFields, _.identity))
                .map(field => metadata(field).default({})('valueHash').default(null)).toJsonString(),
            )
            .eq(patch.dependencyFieldsHash)
          ))
          .value();
        const allPatchHashesAgree = r.and.apply(null, hashChecks);
        return r.branch(allPatchHashesAgree, newsItem.merge(updateQuery), newsItem);
      }, { durability: 'soft', returnChanges: false })
      .run()
      .then((result) => {
        // console.log('[INF] patch result', result);
        if (result.errors > 0) {
          reportError(response, {
            httpStatusCode: 500,
            message: `Failed to update ${tableName} ${rowId}`,
            description: result.first_error,
          });
          next();
        } else if (result.skipped === 1) {
          reportError(response, {
            httpStatusCode: 409, // 409 – Conflict
            message: `${tableName} ${rowId} not found`,
            description: 'Cannot patch nonexistent NewsItem',
          });
          next();
        } else if (result.unchanged === 1) {
          reportError(response, {
            httpStatusCode: 409, // 409 – Conflict
            message: 'Update failed hashes dont agree with current values',
            description: 'Hash constraints failed',
          });
          next();
        } else {
          response.status(200).end(); // 200 – OK
            // .location(`${topLevelPath}/${result.changes[0].new_val.id}`)
            // .json(result.changes[0].new_val);
        }
      })
      .error((err) => {
        reportError(response, {
          httpStatusCode: 500,
          message: `Failed to update ${tableName} ${rowId}`,
          description: err,
        });
        next();
      });
  }
}
