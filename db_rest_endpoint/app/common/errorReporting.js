/* eslint no-console: [2, { allow: ["log", "warn", "error", "assert"] }] */

// FIXME: should add apiErrorCode
// see http://www.vinaysahni.com/best-practices-for-a-pragmatic-restful-api#errors
export function reportError(response, { httpStatusCode, message, description, errors }) {
  // ignore hash constraint failures
  if (description !== 'Hash constraints failed') {
    console.log('[INF] error encountered', message, errors, description);
  }
  response.status(httpStatusCode).json({
    message,
    description,
    errors,
  });
}

export function formatValidationErrors(validationErrors) {
  return validationErrors.map(error => (
    {
      message: error.message,
      dataPath: error.dataPath,
      receivedData: error.data,
    }
  ));
}
