import { expect } from 'chai';

export function validateDBConfig(dbConfig) {
  expect(dbConfig, 'dbConfig').to.be.an('object');
  expect(dbConfig, 'dbConfig').to.have.all.keys(['host', 'port', 'dbName', 'tables']);

  expect(dbConfig, 'dbConfig').to.have.property('host').with.a('string');
  expect(dbConfig, 'dbConfig').to.have.property('port').with.a('number');
  expect(dbConfig, 'dbConfig').to.have.property('dbName').with.a('string');
  expect(dbConfig, 'dbConfig').to.have.property('tables').with.an('object');
}

export function validateConfig(config) {
  expect(config, 'config').to.be.an('object');
  expect(config, 'config').to.have.all.keys(['db']);

  validateDBConfig(config.db);
}


export function validateEndpointSpec(endpointSpec) {
  expect(endpointSpec, 'endpointSpec').to.be.an('object');

  expect(endpointSpec, 'endpointSpec').to.have.property('endpointType')
    .with.oneOf(['remoteRestfulEndpoint', 'localFnEndpoint', 'localStreamingFnEndpoint', 'rabbitmqClient']);

  if (endpointSpec.endpointType === 'localFnEndpoint') {
    expect(endpointSpec, 'endpointSpec').to.have.property('fn')
      .with.a('function');
  } else if (endpointSpec.endpointType === 'localStreamingFnEndpoint') {
    expect(endpointSpec, 'endpointSpec').to.have.property('fn')
      .with.a('function');
  } else if (endpointSpec.endpointType === 'remoteRestfulEndpoint') {
    expect(endpointSpec, 'endpointSpec').to.have.property('url')
      .with.an('object');

    expect(endpointSpec, 'endpointSpec').to.have.deep.property('url.protocol')
      .with.a('string');
    expect(endpointSpec, 'endpointSpec').to.have.deep.property('url.hostname')
      .with.a('string');
    expect(endpointSpec, 'endpointSpec').to.have.deep.property('url.pathname')
      .with.a('string');
  }
}

export function validateWorkerSpec(workerSpec) {
  expect(workerSpec, 'workerSpec').to.be.an('object');

  expect(workerSpec, 'workerSpec').to.have.property('endpointSpec').with.an('object');
  validateEndpointSpec(workerSpec.endpointSpec);

  expect(workerSpec, 'workerSpec').to.have.property('inputSchema').with.an('object');
  expect(workerSpec, 'workerSpec').to.have.property('outputSchema').with.an('object');
}

export function validateTaskSpec(taskSpec) {
  expect(taskSpec, 'taskSpec').to.be.an('object');

  expect(taskSpec, 'taskSpec').to.have.property('taskName').with.a('string');
  expect(taskSpec, 'taskSpec').to.have.property('taskVersion').with.a('string');
  expect(taskSpec, 'taskSpec').to.have.property('exchangeName').with.a('string');

  expect(taskSpec, 'taskSpec').to.have.property('tableName').with.a('string');
  expect(taskSpec, 'taskSpec').to.have.property('fieldSpec').with.an('object');
  // each property-key is a resultFieldName, each value is array of needed field names

  expect(taskSpec, 'taskSpec').to.have.property('workerSpec').with.an('object');
  validateWorkerSpec(taskSpec.workerSpec);
}
