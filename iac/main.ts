import { App } from 'cdktf';
import { InfraStack } from './lib/infra-stack';

const app = new App();
new InfraStack(app, 'tv-devops-assessment-infra');
app.synth();
