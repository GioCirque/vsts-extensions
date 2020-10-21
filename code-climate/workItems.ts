import path from 'path';
import MarkdownIt from 'markdown-it';
import * as tl from 'azure-pipelines-task-lib/task';
import MarkdownItHighlightJs from 'markdown-it-highlightjs';
import Axios, { AxiosRequestConfig, AxiosResponse } from 'axios';
import {
  AnalysisIssue,
  QueryCondition,
  WorkItem,
  WorkItemBatch,
  WorkItemField,
  WorkItemPatch,
  WorkItemQueryResult,
  WorkItemType,
} from './types';

export class WorkItemClient {
  private readonly axiosConfig: AxiosRequestConfig;
  private readonly axiosConfigFallback: AxiosRequestConfig;
  private readonly witUrls = {
    Fields: 'fields',
    WIQL: 'wiql',
    WorkItemsBatch: 'workitemsbatch',
    WorkItems: 'workitems',
  };
  private markdown = new MarkdownIt({ linkify: true, typographer: true, xhtmlOut: true }).use(MarkdownItHighlightJs, {
    inline: true,
  });

  constructor(collectionUrl: string, projName: string, accessToken: string) {
    this.axiosConfig = {
      baseURL: `${collectionUrl}/${projName}/_apis/wit`,
      params: { 'api-version': '6.0' },
      headers: {
        authorization: `Bearer ${accessToken}`,
      },
      responseType: 'json',
    };
    this.axiosConfigFallback = {
      ...this.axiosConfig,
      baseURL: `${collectionUrl}/_apis/wit`,
    };
  }

  private maybeLogError<T>(response: AxiosResponse<T>) {
    if (response.status !== 200) {
      tl.debug(`Error ${response.status}: ${response.statusText}`);
      tl.debug(
        typeof response.data !== 'object' ? ((response.data as unknown) as string) : JSON.stringify(response.data)
      );
      return true;
    }
    return undefined;
  }

  private async tryCatch<T>(op: () => Promise<T>): Promise<T | undefined> {
    try {
      return await op();
    } catch (error) {
      tl.error(`${error.name}: ${error.message}\n${error.stack}`);
    }
    return undefined;
  }

  async create(type: WorkItemType, issue: AnalysisIssue, component: string, buildVersion: string) {
    return this.tryCatch(async () => {
      const workItemUrl = path.join(this.witUrls.WorkItems, `$${type.toLowerCase()}`);
      const titlePrefix = issue.check_name[0].toUpperCase() + issue.check_name.replace('-', ' ').slice(1);
      const basicDesc = `<ol><li>Open ${component} > ${issue.location.path} and observe lines ${issue.location.positions.begin.line} - ${issue.location.positions.end.line}.</li></ol>`;
      const extDesc = this.markdown.render(issue.content.body);
      const ops = [
        {
          op: 'add',
          path: '/fields/CodeClimate.Fingerprint',
          value: issue.fingerprint,
          from: null,
        },
        {
          op: 'add',
          path: '/fields/System.Tags',
          value: ['Code Climate', ...issue.categories, issue.check_name].join(','),
          from: null,
        },
        {
          op: 'add',
          path: '/fields/System.Title',
          value: `${titlePrefix} in ${component} > ${issue.location.path}`,
          from: null,
        },
        {
          op: 'add',
          path: '/fields/System.State',
          value: 'New',
          from: null,
        },
        {
          op: 'add',
          path: '/fields/Microsoft.VSTS.Build.FoundIn',
          value: `${component}_${buildVersion}`,
          from: null,
        },
        {
          op: 'add',
          path: '/fields/Microsoft.VSTS.Scheduling.Effort',
          value: Math.max(1, issue.remediation_points / 10000).toString(),
          from: null,
        },
        {
          op: 'add',
          path: '/fields/Microsoft.VSTS.TCM.ReproSteps',
          value: `${issue.description}<br/><br/>${basicDesc}<br/><br/>${extDesc}`,
          from: null,
        },
      ];
      const result = await Axios.patch<WorkItem>(workItemUrl, ops, { ...this.axiosConfig });
      const isError = this.maybeLogError(result);
      if (isError) throw new Error(result.statusText);

      return result.data;
    });
  }

  async update(id: number, ...ops: WorkItemPatch) {
    return this.tryCatch(async () => {
      const workItemUrl = path.join(this.witUrls.WorkItems, id.toString());
      const result = await Axios.patch<WorkItem>(workItemUrl, ops, { ...this.axiosConfig });
      const isError = this.maybeLogError(result);
      if (isError) throw new Error(result.statusText);

      return result.data;
    });
  }

  async get(fields: string[], ...ids: number[]) {
    return this.tryCatch(async () => {
      const result = await Axios.post<WorkItemBatch>(
        this.witUrls.WorkItemsBatch,
        { ids, fields },
        { ...this.axiosConfig }
      );
      const isError = this.maybeLogError(result);
      if (isError) throw new Error(result.statusText);

      return result.data;
    });
  }

  async query(fields: string[], conditions: QueryCondition[]) {
    return this.tryCatch(async () => {
      const fieldSet = fields.map((v) => `[${v}]`).join(', ');
      const conditionSet = conditions.map((c) => `[${c.fieldName}] ${c.operator} ${c.value}`).join(' AND ');
      const wiqlQuery = `Select ${fieldSet} From WorkItems Where ${conditionSet}`;
      const result = await Axios.post<WorkItemQueryResult>(
        this.witUrls.WIQL,
        { query: wiqlQuery },
        { ...this.axiosConfig }
      );
      const isError = this.maybeLogError(result);
      if (isError) throw new Error(result.statusText);

      return result.data;
    });
  }

  async fieldEnsure(fieldName: string, factory: (fieldName: string) => WorkItemField) {
    let field!: WorkItemField | undefined;
    try {
      field = await this.fieldGet(fieldName);
    } catch (error) {
      if (!factory) throw error;
      field = await this.fieldCreate(factory(fieldName));
    }
    return field;
  }

  async fieldCreate(field: WorkItemField) {
    return this.tryCatch(async () => {
      const result = await Axios.post<WorkItemField>(this.witUrls.Fields, field, { ...this.axiosConfig });
      const isError = this.maybeLogError(result);
      if (isError) throw new Error(result.statusText);

      return result.data;
    });
  }

  async fieldGet(fieldName: string) {
    return this.tryCatch(async () => {
      const fieldUrl = path.join(this.witUrls.Fields, fieldName);
      const [result, fallback] = await Promise.all([
        Axios.get<WorkItemField>(fieldUrl, { ...this.axiosConfig }),
        Axios.get<WorkItemField>(fieldUrl, { ...this.axiosConfigFallback }),
      ]);
      const isError = this.maybeLogError(result);
      if (isError) throw new Error(result.statusText);

      return result.status === 200 ? result.data : fallback.data;
    });
  }
}