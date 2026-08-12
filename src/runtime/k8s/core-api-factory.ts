/**
 * The default lazy `CoreV1Api` factory (extracted from `./provider.ts`,
 * warren-c9ac — frozen size budget): loads in-cluster (or kubeconfig) config
 * and constructs the client on FIRST call, memoized thereafter. Not invoked
 * at construction, so importing this never requires a reachable cluster.
 */

import { CoreV1Api, KubeConfig } from "@kubernetes/client-node";

/** Build the memoized lazy factory `K8sProviderDeps.coreApi` defaults to. */
export function defaultCoreApiFactory(): () => CoreV1Api {
	let cached: CoreV1Api | undefined;
	return () => {
		if (cached === undefined) {
			const kc = new KubeConfig();
			kc.loadFromDefault();
			cached = kc.makeApiClient(CoreV1Api);
		}
		return cached;
	};
}
