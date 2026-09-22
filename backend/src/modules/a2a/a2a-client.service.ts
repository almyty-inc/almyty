import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import axios from 'axios';
import { v4 as uuid } from 'uuid';

import { ExternalAgent } from '../../entities/external-agent.entity';
import { CredentialsService } from '../credentials/credentials.service';
import { EnvelopeCryptoService } from '../kms/envelope-crypto.service';
import { assertOutboundUrlAllowed } from '../../common/security/safe-fetch';
import { ssrfSafeHttpAgent, ssrfSafeHttpsAgent } from '../../common/security/ssrf-safe-agent';

@Injectable()
export class A2AClientService {
  private readonly logger = new Logger(A2AClientService.name);

  constructor(
    @InjectRepository(ExternalAgent)
    private readonly externalAgentRepository: Repository<ExternalAgent>,
    private readonly credentialsService: CredentialsService,
    private readonly envelopeCrypto: EnvelopeCryptoService,
  ) {}

  /**
   * Every JSON-RPC call to an external agent, gated.
   *
   * `baseRpcUrl` is written straight from the request body by
   * ExternalAgentsService.create/update (and, second-order, from the
   * remote agent card's own `url`), and these requests carry the stored
   * credential's auth headers. Ungated, that was an authenticated POST to
   * any address the caller named — cloud metadata, an in-cluster admin
   * port — with the response returned as the sub_agent node's result.
   * `agentCardUrl` has been through validateUrl since it was added;
   * `baseRpcUrl` never was.
   */
  private async rpcPost(
    rpcUrl: string,
    payload: unknown,
    headers: Record<string, string>,
  ): Promise<{ data: any }> {
    const url = assertOutboundUrlAllowed(rpcUrl);
    return axios.post(url, payload, {
      headers,
      timeout: 30_000,
      maxRedirects: 0,
      httpAgent: ssrfSafeHttpAgent,
      httpsAgent: ssrfSafeHttpsAgent,
    });
  }

  /**
   * Resolve credential and build auth headers for an external agent.
   */
  async buildHeaders(externalAgent: ExternalAgent): Promise<Record<string, string>> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    if (!externalAgent.credentialId) {
      return headers;
    }

    try {
      const credential = await this.credentialsService.findById(
        externalAgent.credentialId,
        externalAgent.organizationId,
      );
      // Warm the org's DEK before sync getAuthHeaders (no-op for non-KMS orgs).
      await this.envelopeCrypto.warmOrg(credential.organizationId);
      const authHeaders = credential.getAuthHeaders();
      Object.assign(headers, authHeaders);
    } catch (err: any) {
      this.logger.warn(
        `Failed to resolve credential '${externalAgent.credentialId}' for external agent '${externalAgent.id}': ${err.message}`,
      );
    }

    return headers;
  }

  /**
   * Send a message/send JSON-RPC request to an external agent.
   */
  async sendMessage(externalAgent: ExternalAgent, text: string): Promise<any> {
    const rpcUrl = externalAgent.baseRpcUrl;
    if (!rpcUrl) {
      throw new Error(`External agent '${externalAgent.id}' has no baseRpcUrl configured`);
    }

    const headers = await this.buildHeaders(externalAgent);

    // This client speaks the v0.2.x / v0.3.x dialect: slash-cased method names,
    // lowercase `role`, and Parts discriminated by `kind`. That is what the
    // overwhelming majority of deployed A2A agents (a2a-js / a2a-python SDKs)
    // still serve. `{ type: 'text' }` matches no released version of the spec
    // and leaves the remote agent with an empty message.
    const payload = {
      jsonrpc: '2.0',
      id: uuid(),
      method: 'message/send',
      params: {
        message: {
          messageId: uuid(),
          role: 'user',
          parts: [{ kind: 'text', text }],
        },
      },
    };

    this.logger.log(`[A2A_CLIENT] Sending message/send to ${rpcUrl}`);

    const response = await this.rpcPost(rpcUrl, payload, headers);

    // Track request stats
    await this.trackRequest(externalAgent, !response.data?.error);

    return response.data;
  }

  /**
   * Send a tasks/get JSON-RPC request to an external agent.
   */
  async getTask(externalAgent: ExternalAgent, taskId: string): Promise<any> {
    const rpcUrl = externalAgent.baseRpcUrl;
    if (!rpcUrl) {
      throw new Error(`External agent '${externalAgent.id}' has no baseRpcUrl configured`);
    }

    const headers = await this.buildHeaders(externalAgent);

    const payload = {
      jsonrpc: '2.0',
      id: uuid(),
      method: 'tasks/get',
      params: { id: taskId },
    };

    const response = await this.rpcPost(rpcUrl, payload, headers);

    return response.data;
  }

  /**
   * Send a tasks/cancel JSON-RPC request to an external agent.
   */
  async cancelTask(externalAgent: ExternalAgent, taskId: string): Promise<any> {
    const rpcUrl = externalAgent.baseRpcUrl;
    if (!rpcUrl) {
      throw new Error(`External agent '${externalAgent.id}' has no baseRpcUrl configured`);
    }

    const headers = await this.buildHeaders(externalAgent);

    const payload = {
      jsonrpc: '2.0',
      id: uuid(),
      method: 'tasks/cancel',
      params: { id: taskId },
    };

    const response = await this.rpcPost(rpcUrl, payload, headers);

    return response.data;
  }

  private async trackRequest(externalAgent: ExternalAgent, success: boolean): Promise<void> {
    try {
      await this.externalAgentRepository.increment(
        { id: externalAgent.id },
        'totalRequests',
        1,
      );
      if (success) {
        await this.externalAgentRepository.increment(
          { id: externalAgent.id },
          'successfulRequests',
          1,
        );
      }
    } catch (err: any) {
      this.logger.warn(`Failed to track request stats: ${err.message}`);
    }
  }
}
