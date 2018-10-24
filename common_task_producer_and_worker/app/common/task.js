import moment from 'moment';
import { expect } from 'chai';
import Ajv from 'ajv';

const ajv = new Ajv({
  allErrors: true,
  verbose: true,
  jsonPointers: true,
  errorDataPath: 'property',
});

export function createTask(taskSpec, resultFieldName, entity) {
  // expect(taskSpec, 'taskSpec').to.be.an('object');
  // expect(taskSpec, 'taskSpec').to.have.property('fieldSpec').with.an('object');
  // expect(taskSpec.fieldSpec[resultFieldName], 'taskSpec').to.be.an('object');
  // expect(taskSpec, 'taskSpec').to.have.property('taskName').with.a('string');
  // expect(taskSpec, 'taskSpec').to.have.property('tableName').with.a('string');
  // expect(taskSpec, 'taskSpec').to.have.property('taskVersion').with.a('string');
  // expect(entity, 'entity').to.be.an('object');
  // expect(entity, 'entity').to.have.property('id').with.a('string');

  const taskDataTransformerFn = taskSpec.workerSpec.taskTransformerFn || (x => x);
  const taskRoutingKeyFn = taskSpec.taskRoutingKeyFn || (() => undefined);
  const taskSpecificMetadataFn = taskSpec.workerSpec.taskSpecificMetadataFn || (() => undefined);

  const task = {
    routingKey: taskRoutingKeyFn(entity),
    itemId: entity.id,
    dependencyFieldsHash: entity.calculatedDependencyHash,
    payload: {
      taskData: taskDataTransformerFn(entity), // Transform taks to worker form
      taskMetadata: {
        tableName: taskSpec.tableName,
        itemId: entity.id,
        resultFieldName,
        dependencyFieldsHash: entity.calculatedDependencyHash,
        // timestamp slows down ~3x disable for now
        // taskCreatedAt: moment().format('MMMM Do YYYY, hh:mm:ss'),
        taskProducer: {
          name: taskSpec.taskName,
          version: taskSpec.taskVersion,
        },
        taskSpecificMetadata: taskSpecificMetadataFn(entity),
      },
    },
  };

  return task;
}

export function getTaskId(task) {
  return `task___${task.itemId}___${task.dependencyFieldsHash}`;
}

export const taskMetadataSchema = {
  description: 'additional data for processing that need to be capied to the result message',
  type: 'object',
  required: [
    // 'tableName',
    'itemId',
    'resultFieldName',
    'dependencyFieldsHash',
  ],
  properties: {
    tableName: {
      description: 'the name of the db table from where the entity came',
      type: 'string',
    },
    itemId: {
      description: 'the id of the entity that originated the task',
      type: 'string',
    },
    resultFieldName: {
      description: 'the result field name',
      type: 'string',
    },
    dependencyFieldsHash: {
      description: 'the hash of dependency field values',
      type: 'string',
    },
    // // disabled because slowing down significantly
    // taskCreatedAt: {
    //   description: 'local time when the task was created',
    //   type: 'string', // moment().format('MMMM Do YYYY, hh:mm:ss'),
    // },
    taskProducer: {
      description: 'data about the task producer',
      required: ['name', 'version'],
      properties: {
        name: { type: 'string' },
        version: { type: 'string' },
      },
    },
    taskSpecificMetadata: {
      description: 'any extra data needed for the writing of the task result',
    },
  },
};

export const taskContentSchema = {
  title: 'the content of a task message',
  type: 'object',
  required: [
    'taskData',
    'taskMetadata',
  ],
  additionalProperties: false,
  properties: {
    taskData: {
      description: 'the actual data for processing',
    },
    taskMetadata: taskMetadataSchema,
  },
};

const validateTaskContent = ajv.compile(taskContentSchema);

export function validateTask(task) {
  if (!validateTaskContent(task)) {
    throw validateTaskContent.errors;
  }
}
