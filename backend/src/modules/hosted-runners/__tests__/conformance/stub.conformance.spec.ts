import { StubHostedAdapter } from '../../adapters/stub.adapter';
import { hostedAdapterConformance } from './conformance.suite';

hostedAdapterConformance('stub', async () => ({ adapter: new StubHostedAdapter(), creds: {} }));
