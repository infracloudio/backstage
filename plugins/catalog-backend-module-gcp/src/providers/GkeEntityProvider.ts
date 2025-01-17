/*
 * Copyright 2023 The Backstage Authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
import {
  TaskRunner,
  readTaskScheduleDefinitionFromConfig,
} from '@backstage/backend-tasks';
import {
  DeferredEntity,
  EntityProvider,
  EntityProviderConnection,
} from '@backstage/plugin-catalog-node';

import { Logger } from 'winston';
import * as container from '@google-cloud/container';
import {
  ANNOTATION_KUBERNETES_API_SERVER,
  ANNOTATION_KUBERNETES_API_SERVER_CA,
  ANNOTATION_KUBERNETES_AUTH_PROVIDER,
} from '@backstage/plugin-kubernetes-common';
import { Config } from '@backstage/config';
import { SchedulerService } from '@backstage/backend-plugin-api';

/**
 * Catalog provider to ingest GKE clusters
 *
 * @public
 */
export class GkeEntityProvider implements EntityProvider {
  private readonly logger: Logger;
  private readonly scheduleFn: () => Promise<void>;
  private readonly gkeParents: string[];
  private readonly clusterManagerClient: container.v1.ClusterManagerClient;
  private connection?: EntityProviderConnection;

  private constructor(
    logger: Logger,
    taskRunner: TaskRunner,
    gkeParents: string[],
    clusterManagerClient: container.v1.ClusterManagerClient,
  ) {
    this.logger = logger;
    this.scheduleFn = this.createScheduleFn(taskRunner);
    this.gkeParents = gkeParents;
    this.clusterManagerClient = clusterManagerClient;
  }

  public static fromConfig({
    logger,
    scheduler,
    config,
  }: {
    logger: Logger;
    scheduler: SchedulerService;
    config: Config;
  }) {
    return GkeEntityProvider.fromConfigWithClient({
      logger,
      scheduler: scheduler,
      config,
      clusterManagerClient: new container.v1.ClusterManagerClient(),
    });
  }

  public static fromConfigWithClient({
    logger,
    scheduler,
    config,
    clusterManagerClient,
  }: {
    logger: Logger;
    scheduler: SchedulerService;
    config: Config;
    clusterManagerClient: container.v1.ClusterManagerClient;
  }) {
    const gkeProviderConfig = config.getConfig('catalog.providers.gcp.gke');
    const schedule = readTaskScheduleDefinitionFromConfig(
      gkeProviderConfig.getConfig('schedule'),
    );
    return new GkeEntityProvider(
      logger,
      scheduler.createScheduledTaskRunner(schedule),
      gkeProviderConfig.getStringArray('parents'),
      clusterManagerClient,
    );
  }

  getProviderName(): string {
    return `gcp-gke`;
  }

  async connect(connection: EntityProviderConnection): Promise<void> {
    this.connection = connection;
    await this.scheduleFn();
  }

  private filterOutUndefinedDeferredEntity(
    e: DeferredEntity | undefined,
  ): e is DeferredEntity {
    return e !== undefined;
  }

  private filterOutUndefinedCluster(
    c: container.protos.google.container.v1.ICluster | null | undefined,
  ): c is container.protos.google.container.v1.ICluster {
    return c !== undefined && c !== null;
  }

  private clusterToResource(
    cluster: container.protos.google.container.v1.ICluster,
  ): DeferredEntity | undefined {
    const location = `${this.getProviderName()}:${cluster.location}`;

    if (!cluster.name || !cluster.selfLink || !location || !cluster.endpoint) {
      this.logger.warn(
        `ignoring partial cluster, one of name=${cluster.name}, endpoint=${cluster.endpoint}, selfLink=${cluster.selfLink} or location=${cluster.location} is missing`,
      );
      return undefined;
    }

    // TODO fix location type
    return {
      locationKey: location,
      entity: {
        apiVersion: 'backstage.io/v1alpha1',
        kind: 'Resource',
        metadata: {
          annotations: {
            [ANNOTATION_KUBERNETES_API_SERVER]: `https://${cluster.endpoint}`,
            [ANNOTATION_KUBERNETES_API_SERVER_CA]:
              cluster.masterAuth?.clusterCaCertificate || '',
            [ANNOTATION_KUBERNETES_AUTH_PROVIDER]: 'google',
            'backstage.io/managed-by-location': location,
            'backstage.io/managed-by-origin-location': location,
          },
          name: cluster.name,
          namespace: 'default',
        },
        spec: {
          type: 'kubernetes-cluster',
          owner: 'unknown',
        },
      },
    };
  }

  private createScheduleFn(taskRunner: TaskRunner): () => Promise<void> {
    return async () => {
      const taskId = `${this.getProviderName()}:refresh`;
      return taskRunner.run({
        id: taskId,
        fn: async () => {
          try {
            await this.refresh();
          } catch (error) {
            this.logger.error(error);
          }
        },
      });
    };
  }

  private async getClusters(): Promise<
    container.protos.google.container.v1.ICluster[]
  > {
    const clusters = await Promise.all(
      this.gkeParents.map(async parent => {
        const request = {
          parent: parent,
        };
        const [response] = await this.clusterManagerClient.listClusters(
          request,
        );
        return response.clusters?.filter(this.filterOutUndefinedCluster) ?? [];
      }),
    );
    return clusters.flat();
  }

  async refresh() {
    if (!this.connection) {
      throw new Error('Not initialized');
    }

    this.logger.info('Discovering GKE clusters');

    let clusters: container.protos.google.container.v1.ICluster[];

    try {
      clusters = await this.getClusters();
    } catch (e) {
      this.logger.error('error fetching GKE clusters', e);
      return;
    }
    const resources =
      clusters
        .map(c => this.clusterToResource(c))
        .filter(this.filterOutUndefinedDeferredEntity) ?? [];

    this.logger.info(
      `Ingesting GKE clusters [${resources
        .map(r => r.entity.metadata.name)
        .join(', ')}]`,
    );

    await this.connection.applyMutation({
      type: 'full',
      entities: resources,
    });
  }
}
