import path from 'path';
import got, { OptionsOfJSONResponseBody } from 'got';
import MarkdownIt from 'markdown-it';
import * as tl from 'azure-pipelines-task-lib/task';
import { customAlphabet } from 'nanoid/non-secure';
import MarkdownItHighlightJs from 'markdown-it-highlightjs';
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
  private readonly webOpts: OptionsOfJSONResponseBody = {
    searchParams: { 'api-version': '6.0' },
    headers: {
      authorization: `Bearer ${this.accessToken}`,
    },
    resolveBodyOnly: false,
    responseType: 'json',
    isStream: false,
  };

  constructor(
    private readonly collectionUrl: string,
    private readonly projName: string,
    private readonly accessToken: string
  ) {}

  private qualify(url: string, useProject: boolean = true) {
    return useProject
      ? path.join(this.collectionUrl, this.projName, '_apis/wit', url)
      : path.join(this.collectionUrl, '_apis/wit', url);
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
      const result = await got.patch<WorkItem>(workItemUrl, { ...this.webOpts, json: ops });

      return result.body;
    });
  }

  async update(id: number, ...ops: WorkItemPatch) {
    return this.tryCatch(async (context) => {
      const workItemUrl = path.join(this.witUrls.WorkItems, id.toString());

      context.url = workItemUrl;
      context.scope = this.update.name;
      this.log('debug', context, 'Updating work item for analysis issue.');
      const result = await got.patch<WorkItem>(workItemUrl, { ...this.webOpts, json: ops });

      return result.body;
    });
  }

  async get(fields: string[], ...ids: number[]) {
    return this.tryCatch(async (context) => {
      const batchUrl = this.witUrls.WorkItemsBatch;
      context.url = batchUrl;
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
      const result = await got.post<WorkItemBatch>(batchUrl, { ...this.webOpts, json: { ids, fields } });

      return result.body;
    });
  }

  async query(fields: string[], conditions: QueryCondition[]) {
    return this.tryCatch(async (context) => {
      const fieldSet = fields.map((v) => `[${v}]`).join(', ');
      const conditionSet = conditions.map((c) => `[${c.fieldName}] ${c.operator} ${c.value}`).join(' AND ');
      const wiqlQuery = `Select ${fieldSet} From WorkItems Where ${conditionSet}`;
      const wiqlUrl = this.witUrls.WIQL;

      context.url = this.witUrls.WIQL;
      context.scope = this.query.name;
      context.wiqlQuery = wiqlQuery;
      this.log('debug', context, 'Querying work items.');
      const result = await got.post<WorkItemQueryResult>(wiqlUrl, { ...this.webOpts, json: { query: wiqlQuery } });

      return result.body;
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
      const fieldsUrl = this.witUrls.Fields;
      context.url = fieldsUrl;
      context.scope = this.fieldCreate.name;
      context.field = field;
      this.log('debug', context, 'Creating work item field.');
      const result = await got.post<WorkItemField>(fieldsUrl, { ...this.webOpts, json: field });

      return result.body;
    });
  }

  async fieldGet(fieldName: string) {
    return this.tryCatch(async (context) => {
      const fieldUrl = this.witUrls.Fields;
      context.url = fieldUrl;
      context.scope = this.fieldGet.name;
      this.log('debug', context, 'Getting work item field.');
      const [result, fallback] = await Promise.all([
        got<WorkItemField>(fieldUrl, this.webOpts),
        got<WorkItemField>(fieldUrl, this.webOpts),
      ]);

      return result.statusCode === 200 ? result.body : fallback.body;
    });
  }
}
