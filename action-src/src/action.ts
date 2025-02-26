import * as core from '@actions/core';
import { Context as GitHubContext } from '@actions/github/lib/context';
import { Octokit } from '@octokit/core';
import { RunResult } from 'cspell';
import * as glob from 'cspell-glob';
import { existsSync } from 'fs';
import { format } from 'util';
import { AppError } from './error';
import { fetchFilesForCommits, getPullRequestFiles } from './github';
import { CSpellReporterForGithubAction } from './reporter';
import { lint, LintOptions } from './spell';

interface Context {
    githubContext: GitHubContext;
    github: Octokit;
    files: string;
    useEventFiles: boolean;
}

type EventNames = 'push' | 'pull_request';
const supportedEvents = new Set<EventNames | string>(['push', 'pull_request']);

/**
 * [Workflow commands for GitHub Actions - GitHub Docs](https://docs.github.com/en/free-pro-team@latest/actions/reference/workflow-commands-for-github-actions#setting-an-output-parameter)
 */

type InlineWorkflowCommand = 'error' | 'warning' | 'none';

type TrueFalse = 'true' | 'false';

interface ActionParams {
    github_token: string;
    files: string;
    incremental_files_only: string;
    config: string;
    root: string;
    inline: string;
    strict: string;
}

interface ValidActionParams {
    github_token: string;
    files: string;
    incremental_files_only: TrueFalse;
    config: string;
    root: string;
    inline: InlineWorkflowCommand;
    strict: TrueFalse;
}

async function gatherPullRequestFiles(context: Context): Promise<Set<string>> {
    const { github, githubContext } = context;
    const pull_number = githubContext.payload.pull_request?.number;
    if (!pull_number) return new Set();
    return getPullRequestFiles(github as Octokit, { ...githubContext.repo, pull_number });
}

interface Commit {
    id: string;
}

interface PushPayload {
    commits?: Commit[];
}

async function gatherPushFiles(context: Context): Promise<Set<string>> {
    const { github, githubContext } = context;
    const push = githubContext.payload as PushPayload;
    const commits = push.commits?.map((c) => c.id);
    const files = commits && (await fetchFilesForCommits(github as Octokit, githubContext.repo, commits));
    return files || new Set();
}

async function checkSpelling(params: ValidActionParams, files: string[]): Promise<RunResult | true> {
    const options: LintOptions = {
        root: params.root || process.cwd(),
        config: params.config || undefined,
    };

    if (!files.length) {
        return true;
    }

    const collector = new CSpellReporterForGithubAction(params.inline, core);
    await lint(files, options, collector.reporter);

    return collector.result;
}

function friendlyEventName(eventName: EventNames | string): string {
    switch (eventName) {
        case 'push':
            return 'Push';
        case 'pull_request':
            return 'Pull Request';
        default:
            return `'${eventName}'`;
    }
}

function isSupportedEvent(eventName: EventNames | string): eventName is EventNames {
    return supportedEvents.has(eventName);
}

async function gatherFilesFromContext(context: Context): Promise<Set<string>> {
    if (context.useEventFiles) {
        const eventFiles = await gatherFiles(context);
        return filterFiles(context.files, eventFiles);
    }

    const files = new Set<string>(
        context.files
            .split('\n')
            .map((a) => a.trim())
            .filter((a) => !!a)
    );
    return files;
}

/**
 * Gather the set of files to be spell checked.
 * @param context Context
 */
async function gatherFiles(context: Context): Promise<Set<string>> {
    const eventName = context.githubContext.eventName;

    switch (eventName) {
        case 'push':
            return gatherPushFiles(context);
        case 'pull_request':
            return gatherPullRequestFiles(context);
    }
    return new Set();
}

function filterFiles(globPattern: string, files: Set<string>): Set<string> {
    if (!globPattern) return files;

    const matchingFiles = new Set<string>();

    const g = new glob.GlobMatcher(globPattern, { mode: 'include' });
    for (const p of files) {
        if (g.match(p)) {
            matchingFiles.add(p);
        }
    }

    return matchingFiles;
}

function getActionParams(): ActionParams {
    return {
        github_token: core.getInput('github_token', { required: true }),
        files: core.getInput('files'),
        incremental_files_only: tf(core.getInput('incremental_files_only')) || 'true',
        config: core.getInput('config'),
        root: core.getInput('root'),
        inline: (core.getInput('inline') || 'warning').toLowerCase(),
        strict: tf(core.getInput('strict') || 'true'),
    };
}

function tf(v: string | boolean | number): TrueFalse | string {
    const mapValues: Record<string, TrueFalse> = {
        true: 'true',
        t: 'true',
        false: 'false',
        f: 'false',
        '0': 'false',
        '1': 'true',
    };
    v = typeof v === 'boolean' || typeof v === 'number' ? (v ? 'true' : 'false') : v;
    v = v.toLowerCase();
    v = mapValues[v] || v;
    return v;
}

function validateActionParams(params: ActionParams | ValidActionParams): params is ValidActionParams {
    const validations = [
        validateToken,
        validateConfig,
        validateRoot,
        validateInlineLevel,
        validateStrict,
        validateIncrementalFilesOnly,
    ];
    const success = validations.map((fn) => fn(params)).reduce((a, b) => a && b, true);
    if (!success) {
        throw new AppError('Bad Configuration.');
    }
    return true;
}

function validateToken(params: ActionParams) {
    const token = params.github_token;
    return !!token;
}

function validateIncrementalFilesOnly(params: ActionParams) {
    const isIncrementalOnly = params.incremental_files_only;
    const success = isIncrementalOnly === 'true' || isIncrementalOnly === 'false';
    if (!success) {
        core.error('Invalid incremental_files_only setting, must be one of (true, false)');
    }
    return success;
}

function validateConfig(params: ActionParams) {
    const config = params.config;
    const success = !config || existsSync(config);
    if (!success) {
        core.error(`Configuration file "${config}" not found.`);
    }
    return success;
}

function validateRoot(params: ActionParams) {
    const root = params.root;
    const success = !root || existsSync(root);
    if (!success) {
        core.error(`Root path does not exist: "${root}"`);
    }
    return success;
}

function validateInlineLevel(params: ActionParams) {
    const inline = params.inline;
    const success = isInlineWorkflowCommand(inline);
    if (!success) {
        core.error(`Invalid inline level (${inline}), must be one of (error, warning, none)`);
    }
    return success;
}

function validateStrict(params: ActionParams) {
    const isStrict = params.strict;
    const success = isStrict === 'true' || isStrict === 'false';
    if (!success) {
        core.error('Invalid strict setting, must be one of (true, false)');
    }
    return success;
}

const inlineWorkflowCommandSet: Record<InlineWorkflowCommand | string, boolean | undefined> = {
    error: true,
    warning: true,
    none: true,
};

function isInlineWorkflowCommand(cmd: InlineWorkflowCommand | string): cmd is InlineWorkflowCommand {
    return !!inlineWorkflowCommandSet[cmd];
}

export async function action(githubContext: GitHubContext, octokit: Octokit): Promise<boolean> {
    const params = getActionParams();
    if (!validateActionParams(params)) {
        return false;
    }
    const eventName = githubContext.eventName;
    if (params.incremental_files_only === 'true' && !isSupportedEvent(eventName)) {
        const msg = `Unsupported event: '${eventName}'`;
        throw new AppError(msg);
    }
    const context: Context = {
        githubContext,
        github: octokit,
        files: params.files,
        useEventFiles: params.incremental_files_only === 'true',
    };

    core.info(friendlyEventName(eventName));
    core.debug(format('Options: %o', params));
    const files = await gatherFilesFromContext(context);
    const result = await checkSpelling(params, [...files]);
    if (result === true) {
        return true;
    }

    const message = `Files checked: ${result.files}, Issues found: ${result.issues} in ${result.filesWithIssues.size} files.`;
    core.info(message);

    const fnS = (n: number) => (n === 1 ? '' : 's');

    if (params.strict === 'true' && result.issues) {
        const filesWithIssues = result.filesWithIssues.size;
        const err = `${result.issues} spelling issue${fnS(result.issues)} found in ${filesWithIssues} of the ${
            result.files
        } file${fnS(result.files)} checked.`;
        core.setFailed(err);
    }

    return !(result.issues + result.errors);
}
