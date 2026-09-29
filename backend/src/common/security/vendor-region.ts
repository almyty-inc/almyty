import { EgressError } from './safe-fetch';

/**
 * A cloud region that is spliced into a vendor hostname.
 *
 * Google's regional endpoints are `https://{location}-aiplatform.googleapis.com`,
 * and `location` is tenant-written configuration. Spliced in unchecked, it
 * decides the host: `169.254.169.254#` makes the URL
 * `https://169.254.169.254#-aiplatform.googleapis.com`, and `evil.example/`
 * sends the org's Google bearer token to evil.example. A region is letters,
 * digits and hyphens, and nothing else is let through.
 */
const GCP_LOCATION = /^[a-z]+(?:-[a-z]+)*[0-9]+$/;

export function assertGcpLocation(location: string): string {
  if (typeof location !== 'string' || location.length > 40 || !GCP_LOCATION.test(location)) {
    throw new EgressError(`"${String(location).slice(0, 60)}" is not a Google Cloud region`);
  }
  return location;
}

/** The same for an AWS region in `https://bedrock.{region}.amazonaws.com`. */
const AWS_REGION = /^[a-z]{2}(?:-[a-z]+)+-[0-9]+$/;

export function assertAwsRegion(region: string): string {
  if (typeof region !== 'string' || region.length > 30 || !AWS_REGION.test(region)) {
    throw new EgressError(`"${String(region).slice(0, 60)}" is not an AWS region`);
  }
  return region;
}
