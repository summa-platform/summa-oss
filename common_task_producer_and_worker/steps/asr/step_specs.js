/* eslint no-console: [2, { allow: ["log", "warn", "error", "assert"] }] */

// import ffmpeg from 'fluent-ffmpeg';
import _ from 'underscore';

const supportedLanguages = ['en', 'ar', 'de', 'lv', 'es', 'ru', 'fa', 'uk'];

const taskSpec = {
  taskName: 'SUMMA-ASR-Wrapper',
  taskVersion: '0.0.1',

  exchangeName: 'SUMMA-NLP.ASR',
  routingKeys: supportedLanguages,
  taskRoutingKeyFn: item => item.contentDetectedLangCode,

  tableName: 'newsItems',
  fieldSpec: {
    contentTranscribedMainText: {
      dependencyFields: ['sourceItemVideoURL', 'contentDetectedLangCode'],
      dependencyFieldConditions: {
        type: 'all',
        value: [
          { type: 'fieldConditions', value: { field: 'sourceItemVideoURL', status: 'final' } },
          { type: 'fieldConditions', value: { field: 'contentDetectedLangCode', status: 'final', acceptableValues: supportedLanguages } },
        ],
      },
    },
  },

  workerSpec: {
    endpointSpec: { endpointType: 'rabbitmqClient' },
    inputSchema: {
      type: 'object',
      required: ['url'],
      additionalProperties: false,
      properties: {
        url: { type: 'string' },
      },
    },
    outputSchema: {
      type: 'object',
      required: ['segments'],
      additionalProperties: false,
      properties: {
        end_of_stream: {
          type: 'boolean',
          description: 'final result if true',
        },
        end_of_segment: {
          type: 'boolean',
          description: 'end of semi-logical part of audio stream, till pause',
        },
        segments: {
          type: 'array',
          items: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                word: { type: 'string' },
                confidence: {
                  type: 'number',
                  minimum: 0,
                  maximum: 1,
                },
                time: {
                  type: 'number',
                  minimum: 0,
                },
                duration: {
                  type: 'number',
                  minimum: 0,
                },
              },
            },
          },
        },
      },
    },
    resultTransformerFn: result => ({
      segments: _.map(result.segments,
        segment => _.map(segment,
          wordInfo => ({
            ...wordInfo,
            word: wordInfo.word.toLowerCase(),
          }),
        ),
      ),
    }),
    taskTransformerFn: taskData => ({
      // transform hls_cache path to relative url because some workers may be remote
      // the chunks are also served through public entrypoint <public-ip>/video-chunks/
      url: taskData.sourceItemVideoURL.replace('http://livestream_cache_and_chunker:6000/', '/'),
    }),
  },
  // testFn() {
  //   console.log('\ntestFn called');
  //
  //   const videoURL = 'http://livestream_cache_and_chunker:6000/dw-channel-1/chunks/2017-05-21/070528.m3u8';
  //   ffmpeg(videoURL)
  //     .format('wav') // wav needed for summa asr
  //     .outputOptions('-ar 16000') // 16kHz needed for summa asr
  //     .outputOptions('-ac 1') // convert to mono for summa asr
  //     .save('/file_storage/long_48_16.wav')
  //     .on('start', commandLine => console.log(`Spawned Ffmpeg with command: ${commandLine}`))
  //     .on('end', () => console.log('Processing finished !'));
  // },
};


export default taskSpec;
