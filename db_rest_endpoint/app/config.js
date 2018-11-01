
import jsonfile from 'jsonfile';


//
// Config
//
const configFilePath = '/config/config.json';


console.log('Loading configuration');

const config = jsonfile.readFileSync(configFilePath);

console.log('Configuration loaded');

export default config;
