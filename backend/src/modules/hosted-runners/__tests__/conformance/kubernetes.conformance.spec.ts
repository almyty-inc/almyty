import { KubernetesHostedAdapter } from '../../adapters/kubernetes.adapter';
import { KubeApiClient } from '../../adapters/kubernetes/kube-api.client';
import { FakeKubeApi } from '../fake-kube-api';
import { LAYOUT } from '../fixtures';
import { hostedAdapterConformance } from './conformance.suite';

hostedAdapterConformance('kubernetes', async () => {
  const api = new FakeKubeApi();
  const url = await api.start();
  // The adapter is handed a client aimed at the fake; a real connection
  // must be https (kubeConnectionFrom), which a loopback fake is not.
  const adapter = new KubernetesHostedAdapter(() => LAYOUT, (conn) => new KubeApiClient({ ...conn, server: url }));
  return {
    adapter,
    creds: { server: 'https://kube.example.com', token: 'sa-token' },
    teardown: () => api.stop(),
  };
});
