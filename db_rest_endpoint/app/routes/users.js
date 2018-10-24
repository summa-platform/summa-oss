/* eslint no-console: [2, { allow: ["log", "warn", "error", "assert"] }] */
import { Router } from 'express';
import Ajv from 'ajv';
import crypto from 'crypto';
import { argon2i } from 'argon2-ffi';
import _ from 'underscore';
import { reportError, formatValidationErrors } from '../common/errorReporting.js';

const ajv = new Ajv({
  allErrors: true,
  verbose: true,
  jsonPointers: true,
  errorDataPath: 'property',
  v5: true,
});

// Role types
// {label, internalval}
// Administrator, admin
// User, user

const userRoles = [
  { label: 'User', internalval: 'user' },
  { label: 'Administrator', internalval: 'admin' },
];

const createItemSchema = {
  title: 'user schema',
  type: 'object',
  required: [
    'name',
    'password',
    'email',
    'role',
    'isSuspended',
    // 'teamId',
  ],
  additionalProperties: true,
  properties: {
    name: {
      // for gui and statistics
      description: 'name of the user',
      type: 'string',
    },
    password: {
      description: 'initial password that user sends; salted hash will be stored',
      type: 'string',
    },
    email: {
      description: 'email for password resets; used also as a username',
      type: 'string',
    },
    role: {
      description: 'user role',
      type: 'string',
      enum: _.map(userRoles, role => role.internalval),
    },
    isSuspended: {
      description: 'is user suspended',
      type: 'boolean',
    },

    currentPassword: {
      description: 'the current password; used for updates',
      type: 'string',
    },
  },
};

const updateItemSchema = {
  ..._.omit(createItemSchema, 'required'),
  // switch: [{
  //   if: { required: ['password'] },
  //   then: { required: ['currentPassword'] },
  // }],
};

const validateCreateItem = ajv.compile(createItemSchema);
const validateUpdateItem = ajv.compile(updateItemSchema);

function getSaltedHash(password, callback) {
  // calculate salted hash
  crypto.randomBytes(16, (cryptoErr, salt) => {
    if (cryptoErr) {
      callback(cryptoErr);
    } else {
      const passwordBuffer = new Buffer(password);
      argon2i.hash(passwordBuffer, salt)
        .then(saltedPasswordHash => callback(null, saltedPasswordHash));
    }
  });
}


export default (r, topLevelPath) => {
  const table = r.table('users');
  const router = new Router();

  //
  // api design guidelines taken from http://www.vinaysahni.com/best-practices-for-a-pragmatic-restful-api
  //

  // BASICS:
  // GET /news-items - Retrieves a list of news-items
  // GET /news-items/12 - Retrieves a specific news-item
  // POST /news-items - Creates a new news-item
  // PUT /news-items/12 - Updates news-item #12
  // PATCH /news-items/12 - Partially updates news-item #12
  // DELETE /news-items/12 - Deletes news-item #12

  // SELECTING FIELDS
  // Use a fields query parameter that takes a comma separated list of fields to include.
  // GET /tickets?fields=id,subject,customer_name,updated_at&state=open&sort=-updated_at

  // Updates & creation should return a resource representation
  // A PUT, POST or PATCH call may make modifications to fields of the underlying resource
  // that weren't part of the provided parameters
  // (for example: created_at or updated_at timestamps).
  // To prevent an API consumer from having to hit the API again for an updated representation,
  // have the API return the updated (or created) representation as part of the response.
  //
  // In case of a POST that resulted in a creation, use a HTTP 201 status code and include
  // a Location header that points to the URL of the new resource.

  // JSON encoded POST, PUT & PATCH bodies
  // An API that accepts JSON encoded POST, PUT & PATCH requests should also require
  // the Content-Type header be set to application/json or
  // throw a 415 Unsupported Media Type HTTP status code.

  const getQueries = user => ({
    queries: r.table('queries').filter({ user: user('id') }).coerceTo('array').coerceTo('array'),
  });

  router.get('/roleTypes', (request, response) => {
    response.status(200) // 200 - ok
      .json(userRoles);
  });

  router.post('/checkPassword', (request, response, next) => {
    console.log('checkPassword');
    const rawRequestContent = request.body;

    if (!rawRequestContent) {
      response.sendStatus(400).send('Missing request body'); // 400 - Bad Request
      console.log('missing rawRequestContent');
      next();
    }

    if (!rawRequestContent.email || !rawRequestContent.password) {
      response.status(400).send('Missing email or password'); // 400 - Bad Request
      console.log('missing email or pass');
      next();
    }

    table
      .filter(user => user('email').downcase().eq(rawRequestContent.email.toLowerCase()))
      .merge(getQueries)
      .run()
      .then((results) => {
        if (_.isEmpty(results)) {
          response.status(404) // 404 - Not Found
            .json({ message: `No user with email ${rawRequestContent.email}` });
          next();
        } else {
          const encodedHash = results[0].saltedPasswordHash;
          if (encodedHash === undefined) {
            response.sendStatus(401); // 401 - Unauthorised
            next();
          }

          const passwordBuffer = new Buffer(rawRequestContent.password);
          argon2i.verify(encodedHash, passwordBuffer)
            .then((correct) => {
              if (correct) {
                response.status(200) // 200 - OK
                  .location(`${topLevelPath}/${results[0].id}`)
                  .json(_.omit(results[0], 'saltedPasswordHash'));
              } else {
                response.sendStatus(401); // 401 - Unauthorised
              }
              next();
            });
        }
      })
      .error((err) => {
        reportError(response, {
          httpStatusCode: 500,
          message: 'Internal error',
          description: err,
        });
        next();
      });
  });


  router.get('/', (request, response, next) => {
    table
      .merge(getQueries)
      .without('saltedPasswordHash')
      .run()
      .then((result) => {
        response.status(200) // 200 - ok
          .json(result);
        next();
      })
      .error((err) => {
        reportError(response, {
          httpStatusCode: 500,
          message: 'Failed to get users',
          description: err,
        });
        next();
      });
  });

  router.get('/:id', (request, response, next) => {
    const id = request.params.id;
    table
      .get(id)
      .do(item => r.branch(item, item.merge(getQueries).without('saltedPasswordHash'), item))
      .run()
      .then((result) => {
        if (result === null) {
          reportError(response, {
            httpStatusCode: 404, // 404 - Not Found
            message: `no user with id ${id}`,
            errors: `no user with id ${id}`,
          });
          next();
        } else {
          response.status(200) // 200 - ok
            .json(result);
          next();
        }
      })
      .error((err) => {
        reportError(response, {
          httpStatusCode: 500,
          message: 'Failed to get users',
          description: err,
        });
        next();
      });
  });

  router.get('/:id/queries', (request, response, next) => {
    const id = request.params.id;
    table
      .get(id)
      .do(item => r.branch(item, item.merge(getQueries).do(user => user('queries')), item))
      .run()
      .then((result) => {
        if (result === null) {
          reportError(response, {
            httpStatusCode: 404, // 404 - Not Found
            message: `no user with id ${id}`,
            errors: `no user with id ${id}`,
          });
          next();
        } else {
          response.status(200) // 200 - ok
            .json(result);
          next();
        }
      })
      .error((err) => {
        reportError(response, {
          httpStatusCode: 500,
          message: 'Failed to get users',
          description: err,
        });
        next();
      });
  });


  router.post('/', (request, response, next) => {
    console.log('create user');
    const rawRequestContent = request.body;

    const failedToCreateUserDbError = (dbErr) => {
      reportError(response, {
        httpStatusCode: 500,
        message: 'Failed to create User',
        description: dbErr,
      });
      next();
    };

    if (!validateCreateItem(rawRequestContent)) {
      reportError(response, {
        httpStatusCode: 422, // 422 - Unprocessable Entity
        message: 'Validation Failed',
        errors: formatValidationErrors(validateCreateItem.errors),
      });
    } else {
      getSaltedHash(rawRequestContent.password, (cryptoErr, saltedPasswordHash) => {
        if (cryptoErr) {
          reportError(response, {
            httpStatusCode: 500,
            message: 'Failed to create User',
            description: cryptoErr,
          });
          next();
        } else {
          table
            .filter(user => user('email').downcase().eq(rawRequestContent.email.toLowerCase()))
            .run()
            .then((results) => {
              if (results.length !== 0) {
                reportError(response, {
                  httpStatusCode: 409, // 409 - Conflict
                  message: 'user with this email already exists',
                  errors: 'user with this email already exists',
                });
              } else {
                table
                  .insert({
                    ..._.omit(rawRequestContent, 'password'),
                    saltedPasswordHash,
                  }, { returnChanges: true })
                  .run()
                  .then((result) => {
                    if (result.generated_keys.length === 1) {
                      response.status(201) // 201 – created
                        .location(`${topLevelPath}/${result.generated_keys[0]}`)
                        .json(_.omit(result.changes[0].new_val, 'saltedPasswordHash'));
                    } else {
                      reportError(response, {
                        httpStatusCode: 500, // Internal error
                        message: 'should be exactly one new user added',
                        errors: 'should be exactly one new user added',
                      });
                    }
                  })
                  .error(failedToCreateUserDbError);
              }
            })
            .error(failedToCreateUserDbError);
        }
      });
    }
  });

  router.patch('/:id', (request, response, next) => {
    console.log('update user');
    const id = request.params.id;
    const rawRequestContent = request.body;

    const failedToUpdateUserDbError = (dbErr) => {
      reportError(response, {
        httpStatusCode: 500,
        message: `Failed to update User ${id}`,
        description: dbErr,
      });
      next();
    };

    // FIXME - dont allow duplicate emails
    const updateUser = (item, saltedPasswordHash) => {
      console.log('updateUser');
      const emailChangeRequest = Object.prototype.hasOwnProperty.call(rawRequestContent, 'email') && (rawRequestContent.email !== item.email);
      console.log('emailChangeRequest', emailChangeRequest);
      table
        .filter(user => user('email').eq(rawRequestContent.email || item.email).and(user('id').eq(item.id).not()))
        .count()
        .do(count => r.branch(
          r.expr(emailChangeRequest).not().or(count.eq(0)),
          table.get(id).update({
            ..._.omit(rawRequestContent, 'password', 'currentPassword'),
            saltedPasswordHash,
          }, { returnChanges: 'always' }),
          {
            status: 'already exists',
            currentValue: table
              .filter(user => user('email').eq(rawRequestContent.email || item.email).and(user('id').eq(id).not()))
              .without('saltedPasswordHash')
              .coerceTo('array'),
          },
        ))
        .run()
        .then((result) => {
          console.log('result', result);
          if (result.status === 'already exists') {
            reportError(response, {
              httpStatusCode: 409,
              message: `User with email '${rawRequestContent.email}' already exists`,
              description: result,
            });
            next();
          } else {
            response.status(200) // 200 – ok
              .json(_.omit(result.changes[0].new_val, 'saltedPasswordHash'));
            next();
          }
        })
        .error(failedToUpdateUserDbError);
    };

    if (!validateUpdateItem(rawRequestContent)) {
      reportError(response, {
        httpStatusCode: 422, // 422 - Unprocessable Entity
        message: 'Validation Failed',
        errors: formatValidationErrors(validateUpdateItem.errors),
      });
      next();
    } else {
      table
        .get(id)
        .run()
        .then((item) => {
          if (item === null) {
            reportError(response, {
              httpStatusCode: 404, // 404 - Not Found
              message: `no user with id ${id}`,
              errors: `no user with id ${id}`,
            });
          } else {
            if (rawRequestContent.password) { // eslint-disable-line
              getSaltedHash(rawRequestContent.password, (cryptoErr, saltedPasswordHash) => {
                if (cryptoErr) {
                  failedToUpdateUserDbError(cryptoErr);
                  next();
                } else {
                  updateUser(item, saltedPasswordHash);
                }
              });
            } else {
              console.log('update without password change');
              updateUser(item, item.saltedPasswordHash);
            }
          }
        })
        .error(failedToUpdateUserDbError);
    }
  });

  router.delete('/:userId', (request, response, next) => {
    console.log('delete user');
    const userId = request.params.userId;

    const failedToDeleteUserDbError = (dbErr) => {
      reportError(response, {
        httpStatusCode: 500,
        message: `Failed to delete User ${userId}`,
        description: dbErr,
      });
      next();
    };

    table
      .get(userId)
      .run()
      .then((result) => {
        if (result === null) {
          reportError(response, {
            httpStatusCode: 404, // 404 - Not Found
            message: `no user with id ${userId}`,
            errors: `no user with id ${userId}`,
          });
        } else {
          table
            .get(userId)
            .delete()
            .run()
            .then((deletionResult) => {
              console.log('user deleted', deletionResult);
              response.sendStatus(204); // 204 - No Content
              next();
            })
            .error(failedToDeleteUserDbError);
        }
      })
      .error(failedToDeleteUserDbError);
  });


  // bookmark management
  router.get('/:userId/bookmarks', async (request, response, next) => {
    const userId = request.params.userId;

    try {
      const bookmarks = await r.table('bookmarks')
        .getAll(userId, { index: 'userId' })
        .run();

      response.status(200) // 200 – ok
        .json(bookmarks);
      next();
    } catch (err) {
      reportError(response, {
        httpStatusCode: 500,
        message: 'Failed to get bookmarks',
        description: err,
      });
      next();
    }
  });
  router.post('/:userId/bookmarks', async (request, response, next) => {
    const userId = request.params.userId;
    const rawRequestContent = request.body;

    try {
      const result = await r.table('bookmarks')
      .insert({
        ...rawRequestContent,
        userId,
        timeAdded: r.now(),
      }, { returnChanges: true })
      .run();

      response.status(201) // 201 – created
        .location(`${topLevelPath}/${userId}/bookmarks/${result.generated_keys[0]}`)
        .json(result.changes[0].new_val);
      next();
    } catch (err) {
      reportError(response, {
        httpStatusCode: 500,
        message: 'Failed to create bookmark',
        description: err,
      });
      next();
    }
  });
  router.get('/:userId/bookmarks/:bookmarkId', async (request, response, next) => {
    const userId = request.params.userId;
    const bookmarkId = request.params.bookmarkId;

    try {
      const bookmark = await r.table('bookmarks')
        .get(bookmarkId)
        .run();

      console.assert(bookmark.userId === userId, 'bookmark userId must match url userId');

      response.status(200) // 200 – ok
        .json(bookmark);
      next();
    } catch (err) {
      reportError(response, {
        httpStatusCode: 500,
        message: 'Failed to get bookmark',
        description: err,
      });
      next();
    }
  });
  router.patch('/:userId/bookmarks/:bookmarkId', async (request, response, next) => {
    // const userId = request.params.userId;
    const bookmarkId = request.params.bookmarkId;
    const rawRequestContent = request.body || {};

    try {
      const result = await r.table('bookmarks')
        .get(bookmarkId)
        .update(rawRequestContent, { returnChanges: 'always' })
        .run();

      response.status(200) // 200 – ok
        .json(result.changes[0].new_val);
      next();
    } catch (err) {
      reportError(response, {
        httpStatusCode: 500,
        message: 'Failed to update bookmark',
        description: err,
      });
      next();
    }
  });
  router.delete('/:userId/bookmarks/:bookmarkId', async (request, response, next) => {
    const bookmarkId = request.params.bookmarkId;
    try {
      await r.table('bookmarks')
        .get(bookmarkId)
        .delete()
        .run();

      response.sendStatus(204); // 204 - No Content
      next();
    } catch (err) {
      reportError(response, {
        httpStatusCode: 500,
        message: 'Failed to delete bookmark',
        description: err,
      });
      next();
    }
  });

  return router;
};
