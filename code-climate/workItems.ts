import path from 'path';
import MarkdownIt from 'markdown-it';
import * as tl from 'azure-pipelines-task-lib/task';
import { customAlphabet } from 'nanoid/non-secure';
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

type LogType = 'debug' | 'info' | 'warn' | 'error';
type OpContext = { correlationId: string; [key: string]: string | number | boolean | object };

export class WorkItemClient {
  private readonly axiosConfig: AxiosRequestConfig;
  private readonly axiosConfigFallback: AxiosRequestConfig;
  private readonly witUrls = {
    Fields: 'fields',
    WIQL: 'wiql',
    WorkItemsBatch: 'workitemsbatch',
    WorkItems: 'workitems',
  };
  private readonly markdown = new MarkdownIt({ linkify: true, typographer: true, xhtmlOut: true }).use(
    MarkdownItHighlightJs,
    {
      inline: true,
    }
  );
  private readonly nanoid = customAlphabet('1234567890abcdefghijklmnopqrstuvwxyz', 10);

  constructor(collectionUrl: string, projName: string, accessToken: string) {
    this.axiosConfig = {
      baseURL: path.join(collectionUrl, projName, '/_apis/wit'),
      params: { 'api-version': '6.0' },
      headers: {
        authorization: `Bearer ${accessToken}`,
      },
      responseType: 'json',
    };
    this.axiosConfigFallback = {
      ...this.axiosConfig,
      baseURL: path.join(collectionUrl, '/_apis/wit'),
    };
  }

  private log(type: LogType, context: OpContext, message: string) {
    return console[type](`[${context.correlationId}] ${message}`, context);
  }

  private async tryCatch<T>(op: (context: OpContext) => Promise<T>): Promise<T | undefined> {
    const correlationId = this.nanoid();
    const context: OpContext = { correlationId };
    try {
      return await op(context);
    } catch (err) {
      const response = err.response?.data || 'No response data available';
      const error = !!err.toJSON ? err.toJSON() : { name: err.name, message: err.message, stack: err.stack };
      tl.error(`[${correlationId}] ${JSON.stringify({ error, context, response }, undefined, 2)}`);
    }
    return undefined;
  }

  async create(type: WorkItemType, issue: AnalysisIssue, component: string, buildVersion: string) {
    return this.tryCatch(async (context) => {
      const workItemUrl = path.join(this.witUrls.WorkItems, `$${type.toLowerCase()}`);
      const titlePrefix = issue.check_name[0].toUpperCase() + issue.check_name.replace('-', ' ').slice(1);
      const basicDesc = `<ol><li>Open ${component} > ${issue.location.path} and observe lines ${issue.location.positions.begin.line} - ${issue.location.positions.end.line}.</li></ol>`;
      const extDesc = this.markdown.render(issue.content.body);
      const ops = [
        {
          op: 'add',
          path: `/fields/CodeClimate.Fingerprint`,
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

      context.url = workItemUrl;
      context.scope = this.create.name;
      this.log('debug', context, 'Creating work item for analysis issue.');
      const result = await Axios.patch<WorkItem>(workItemUrl, ops, { ...this.axiosConfig });
      return result.data;
    });
  }

  async update(id: number, ...ops: WorkItemPatch) {
    return this.tryCatch(async (context) => {
      const workItemUrl = path.join(this.witUrls.WorkItems, id.toString());

      context.url = workItemUrl;
      context.scope = this.update.name;
      this.log('debug', context, 'Updating work item for analysis issue.');
      const result = await Axios.patch<WorkItem>(workItemUrl, ops, { ...this.axiosConfig });

      return result.data;
    });
  }

  async get(fields: string[], ...ids: number[]) {
    return this.tryCatch(async (context) => {
      context.url = this.witUrls.WorkItemsBatch;
      context.scope = this.get.name;
      context.fields = fields;
      context.ids = ids;
      this.log('debug', context, 'Getting work items.');
      if (!ids || ids.length === 0) {
        return {
          count: 0,
          value: [],
        } as WorkItemBatch;
      }
      const result = await Axios.post<WorkItemBatch>(
        this.witUrls.WorkItemsBatch,
        { ids, fields },
        { ...this.axiosConfig }
      );

      return result.data;
    });
  }

  async query(fields: string[], conditions: QueryCondition[]) {
    return this.tryCatch(async (context) => {
      const fieldSet = fields.map((v) => `[${v}]`).join(', ');
      const conditionSet = conditions.map((c) => `[${c.fieldName}] ${c.operator} ${c.value}`).join(' AND ');
      const wiqlQuery = `Select ${fieldSet} From WorkItems Where ${conditionSet}`;

      context.url = this.witUrls.WIQL;
      context.scope = this.query.name;
      context.wiqlQuery = wiqlQuery;
      this.log('debug', context, 'Querying work items.');
      const result = await Axios.post<WorkItemQueryResult>(
        this.witUrls.WIQL,
        { query: wiqlQuery },
        { ...this.axiosConfig }
      );

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
    return this.tryCatch(async (context) => {
      context.url = this.witUrls.Fields;
      context.scope = this.fieldCreate.name;
      context.field = field;
      this.log('debug', context, 'Creating work item field.');
      const result = await Axios.post<WorkItemField>(this.witUrls.Fields, field, { ...this.axiosConfig });

      return result.data;
    });
  }

  async fieldGet(fieldName: string) {
    return this.tryCatch(async (context) => {
      const fieldUrl = path.join(this.witUrls.Fields, fieldName);
      context.url = fieldUrl;
      context.scope = this.fieldGet.name;
      this.log('debug', context, 'Getting work item field.');
      const [result, fallback] = await Promise.all([
        Axios.get<WorkItemField>(fieldUrl, { ...this.axiosConfig }),
        Axios.get<WorkItemField>(fieldUrl, { ...this.axiosConfigFallback }),
      ]);

      return result.status === 200 ? result.data : fallback.data;
    });
  }
}
