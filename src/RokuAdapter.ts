import { Socket } from "net";
import * as EventEmitter from 'events';
import * as eol from 'eol';


/**
 * A class that connects to a Roku device over telnet debugger port and provides a standardized way of interacting with it.
 */
export class RokuAdapter {
    constructor(private host: string) {
        this.emitter = new EventEmitter();
    }
    private requestPipeline: RequestPipeline;
    private emitter: EventEmitter;
    private isSuspended = false;

    private cache = {};

    /**
     * Subscribe to various events
     * @param eventName 
     * @param handler 
     */
    public on(eventName: 'suspend', handler: () => void)
    public on(eventName: 'compile-error', handler: (params: { path: string; lineNumber: number; }) => void)
    public on(eventName: 'close', handler: () => void)
    public on(eventName: string, handler: (payload: any) => void) {
        this.emitter.on(eventName, handler);
        return () => {
            this.emitter.removeListener(eventName, handler);
        };
    }

    private emit(eventName: 'suspend' | 'compile-error' | 'close', data?) {
        this.emitter.emit(eventName, data);
    }

    private clientDisconnectors: any[] = [];

    /**
     * The debugger needs to tell us when to be active (i.e. when the package was deployed)
     */
    public isActivated = false;
    /**
     * Every time we get a message that ends with the debugger prompt, 
     * this will be set to true. Otherwise, it will be set to false
     */
    public isAtDebuggerPrompt = false;
    public async activate() {
        this.isActivated = true;
        //if we are already sitting at a debugger prompt, we need to emit the first suspend event.
        //If not, then there are probably still messages being received, so let the normal handler
        //emit the suspend event when it's ready
        if (this.isAtDebuggerPrompt === true) {
            let threads = await this.getThreads();
            this.emit('suspend', threads[0].threadId);

        }
    }

    /**
     * Allows other methods to disable the main data listener
     */
    private enableMainDataListener = true;

    /**
     * Connect to the telnet session. This should be called before the channel is launched, and there should be a breakpoint set at the first
     * line of the entry function of the source code
     */
    public connect() {
        return new Promise((resolve, reject) => {
            var net = require('net');
            let client: Socket = new net.Socket();

            client.connect(8085, this.host, (err, data) => {
                let k = 2;
            });
            this.requestPipeline = new RequestPipeline(client);

            let resolved = false;
            this.clientDisconnectors.push(
                this.requestPipeline.on('unhandled-data', async (data) => {
                    if (!this.enableMainDataListener) {
                        return;
                    }
                    //resolve the connection once the data events have settled
                    if (!resolved) {
                        resolved = true;
                        resolve();
                        return;
                    }
                    let dataString = data.toString();
                    let match;

                    //watch for compile errors
                    if (match = /compile error.* in (.*)\((\d+)\)/i.exec(dataString)) {
                        let path = match[1];
                        let lineNumber = match[2];
                        this.emit('compile-error', { path, lineNumber });
                    }

                    if (this.isActivated) {
                        //console.log(dataString);

                        //we are guaranteed that there will be a breakpoint on the first line of the entry sub, so
                        //wait until we see the brightscript debugger prompt
                        if (match = /Brightscript\s+Debugger>\s+$/i.exec(dataString)) {
                            //if we are activated AND this is the first time seeing the debugger prompt since a continue/step action
                            if (this.isActivated && this.isAtDebuggerPrompt === false) {
                                this.emit('suspend');
                            }
                            this.isAtDebuggerPrompt = true;
                        } else {
                            this.isAtDebuggerPrompt = false;
                        }
                    }
                })
            );

            function addListener(name: string, handler: any) {
                client.addListener(name, handler);
                return () => {
                    client.removeListener(name, handler);
                };
            }

            this.clientDisconnectors.push(
                addListener('close', (err, data) => {
                    this.emit('close');
                })
            );

            //if the connection fails, reject the connect promise
            this.clientDisconnectors.push(
                addListener('error', function (err) {
                    //this.emit(EventName.error, err);
                    reject(err);
                })
            );
        });
    }

    /**
     * Send command to step over
     */
    public stepOver() {
        this.clearState();
        return this.requestPipeline.executeCommand('over', false);
    }

    public stepInto() {
        this.clearState();
        return this.requestPipeline.executeCommand('step', false);
    }

    public stepOut() {
        this.clearState();
        return this.requestPipeline.executeCommand('out', false);

    }

    /**
     * Tell the brightscript program to continue (i.e. resume program)
     */
    public continue() {
        this.clearState();
        return this.requestPipeline.executeCommand('c', false);
    }

    /**
     * Tell the brightscript program to pause (fall into debug mode)
     */
    public pause() {
        this.clearState();
        //send the kill signal, which breaks into debugger mode
        return this.requestPipeline.executeCommand('\x03;', false);
    }

    /**
     * Clears the state, which means that everything will be retrieved fresh next time it is requested
     */
    public clearState() {
        this.cache = {};
        this.isAtDebuggerPrompt = false;
    }

    public getStackTrace() {
        return this.resolve('stackTrace', async () => {
            //perform a request to load the stack trace
            let responseText = await this.requestPipeline.executeCommand('bt', true);
            let regexp = /#(\d+)\s+(?:function|sub)\s+([\w\d]+).*\s+file\/line:\s+(.*)\((\d+)\)/ig;
            let matches;
            let frames: StackFrame[] = [];
            while (matches = regexp.exec(responseText)) {
                //the first index is the whole string
                //then the matches should be in pairs
                for (let i = 1; i < matches.length; i = i + 4) {
                    let j = 1;
                    let frameId = parseInt(matches[i]);
                    let functionIdentifier = matches[i + j++]
                    let filePath = matches[i + j++];
                    let lineNumber = parseInt(matches[i + j++]);
                    let frame: StackFrame = {
                        frameId,
                        filePath,
                        lineNumber,
                        functionIdentifier
                    }
                    frames.push(frame);
                }
            }
            //if we didn't find frames yet, then there's not much more we can do...
            return frames;
        });
    }


    private expressionRegex = /([\s|\S]+?)(?:\r|\r\n)+brightscript debugger>/i;
    /**
     * Given an expression, evaluate that statement ON the roku
     * @param expression
     */
    public async getVariable(expression: string) {
        return this.resolve(`variable: ${expression}`, async () => {
            let expressionType = await this.getType(expression);

            let lowerExpressionType = expressionType ? expressionType.toLowerCase() : null;

            let data: string;
            //if the expression type is a string, we need to wrap the expression in quotes BEFORE we run the print so we can accurately capture the full string value
            if (lowerExpressionType === 'string') {
                data = await this.requestPipeline.executeCommand(`print "--string-wrap--" + ${expression} + "--string-wrap--"`, true);
            }
            else {
                data = await this.requestPipeline.executeCommand(`print ${expression}`, true);
            }

            let match;
            if (match = this.expressionRegex.exec(data)) {
                let value = match[1];
                if (lowerExpressionType === 'string') {
                    value = value.trim().replace(/--string-wrap--/g, '');
                    //add an escape character in front of any existing quotes
                    value = value.replace(/"/g, '\\"');
                    //wrap the string value with literal quote marks
                    value = '"' + value + '"';
                } else {
                    value = value.trim();
                }

                let highLevelType = this.getHighLevelType(expressionType);

                let children: EvaluateContainer[];
                if (highLevelType === 'object') {
                    children = this.getObjectChildren(expression, value);
                } else if (highLevelType === 'array') {
                    children = this.getArrayChildren(expression, value);
                }

                let container = <EvaluateContainer>{
                    name: expression,
                    evaluateName: expression,
                    type: expressionType,
                    value: value,
                    highLevelType,
                    children
                };
                return container;
            }
        });
    }

    getArrayChildren(expression: string, data: string): EvaluateContainer[] {
        let children: EvaluateContainer[] = [];
        //split by newline. the array contents start at index 2
        let lines = eol.split(data);
        let arrayIndex = 0;
        for (let i = 2; i < lines.length; i++) {
            let line = lines[i].trim();
            if (line === ']') {
                return children;
            }
            let child = <EvaluateContainer>{
                name: arrayIndex.toString(),
                evaluateName: `${expression}[${arrayIndex}]`,
                children: []
            };

            //if the line is an object, array or function
            let match;
            if (match = /<.*:\s+(\w*)>/gi.exec(line)) {
                let type = match[1];
                child.type = type;
                child.highLevelType = this.getHighLevelType(type);
                child.value = type;
            } else {
                child.type = this.getPrimativeTypeFromValue(line);
                child.value = line;
                child.highLevelType = HighLevelType.primative;
            }
            children.push(child);
            arrayIndex++;
        }
        throw new Error('Unable to parse BrightScript array');
    }

    private getPrimativeTypeFromValue(value: string): PrimativeType {
        value = value ? value.toLowerCase() : value;
        if (!value || value === 'invalid') {
            return PrimativeType.invalid;
        }
        if (value === 'true' || value === 'false') {
            return PrimativeType.boolean;
        }
        if (value.indexOf('"') > -1) {
            return PrimativeType.string;
        }
        if (value.split('.').length > 1) {
            return PrimativeType.integer;
        } else {
            return PrimativeType.float;
        }

    }

    getObjectChildren(expression: string, data: string): EvaluateContainer[] {
        try {
            let children: EvaluateContainer[] = [];
            //split by newline. the object contents start at index 2
            let lines = eol.split(data);
            for (let i = 2; i < lines.length; i++) {
                let line = lines[i].trim();
                if (line === '}') {
                    return children;
                }
                let match;
                match = /(\w+):(.+)/i.exec(line);
                let name = match[1].trim();
                let value = match[2].trim();

                let child = <EvaluateContainer>{
                    name: name,
                    evaluateName: `${expression}.${name}`,
                    children: []
                };

                //if the line is an object, array or function
                if (match = /<.*:\s+(\w*)>/gi.exec(line)) {
                    let type = match[1];
                    child.type = type;
                    child.highLevelType = this.getHighLevelType(type);
                    child.value = type;
                } else {
                    child.type = this.getPrimativeTypeFromValue(line);
                    child.value = value;
                    child.highLevelType = HighLevelType.primative;
                }
                children.push(child);
            }
            return children;
        } catch (e) {
            throw new Error(`Unable to parse BrightScript object: ${e.message}. Data: ${data}`);
        }
    }

    /**
     * Determine if this value is a primative type
     * @param expressionType 
     */
    private getHighLevelType(expressionType: string) {
        if (!expressionType) {
            throw new Error(`Unknown expression type: ${expressionType}`);
        }

        expressionType = expressionType.toLowerCase();
        let primativeTypes = ['boolean', 'integer', 'longinteger', 'float', 'double', 'string', 'invalid'];
        if (primativeTypes.indexOf(expressionType) > -1) {
            return HighLevelType.primative;
        } else if (expressionType === 'roarray') {
            return HighLevelType.array;
        } else if (expressionType === 'function') {
            return HighLevelType.function;
        } else {
            return HighLevelType.object;
        }
    }

    /**
     * Get the type of the provided expression
     * @param expression 
     */
    public async getType(expression) {
        expression = `Type(${expression})`;
        return this.resolve(`${expression}`, async () => {
            let data = await this.requestPipeline.executeCommand(`print ${expression}`, true);

            let match;
            if (match = this.expressionRegex.exec(data)) {
                let typeValue: string = match[1];
                //remove whitespace
                typeValue = typeValue.trim();
                return typeValue;
            } else {
                return null;
            }
        });
    }

    /**
     * Cache items by a unique key
     * @param expression 
     * @param factory 
     */
    private resolve<T>(key: string, factory: () => T | Thenable<T>): Promise<T> {
        if (this.cache[key]) {
            return this.cache[key];
        }
        return this.cache[key] = Promise.resolve<T>(factory());
    }

    /**
     * Get a list of threads. The first thread in the list is the active thread
     */
    public async getThreads() {
        return this.resolve('threads', async () => {
            //since the main data listener handles every prompt, but also calls this current function, we need to disable its handling
            //until we get our threads result
            this.enableMainDataListener = false;

            let data = await this.requestPipeline.executeCommand('threads', true);
            //re-enable the listener for future requests
            this.enableMainDataListener = true;

            let dataString = data.toString();
            let matches;
            let threads: Thread[] = [];
            if (matches = /^\s+(\d+\*)\s+(.*)\((\d+)\)\s+(.*)/gm.exec(dataString)) {
                //skip index 0 because it's the whole string
                for (let i = 1; i < matches.length; i = i + 4) {
                    let threadId: string = matches[i];
                    let thread = <Thread>{
                        isSelected: false,
                        filePath: matches[i + 1],
                        lineNumber: parseInt(matches[i + 2]),
                        lineContents: matches[i + 3]
                    }
                    if (threadId.indexOf('*') > -1) {
                        thread.isSelected = true;
                        threadId = threadId.replace('*', '');
                    }
                    thread.threadId = parseInt(threadId);
                    threads.push(thread);
                }
                //make sure the selected thread is at the top
                threads.sort((a, b) => {
                    return a.isSelected ? -1 : 1;
                });
            }
            return threads;
        });
    }

    /**
     * Disconnect from the telnet session and unset all objects
     */
    public destroy() {
        //disconnect all client listeners
        for (let disconnect of this.clientDisconnectors) {
            disconnect();
        }
        this.requestPipeline.destroy();
        this.requestPipeline = undefined;
        this.cache = undefined;
        this.emitter.removeAllListeners();
        this.emitter = undefined;
    }
}

export interface StackFrame {
    frameId: number;
    filePath: string;
    lineNumber: number;
    functionIdentifier: string;
}

export enum EventName {
    suspend = 'suspend'
}

export enum HighLevelType {
    primative = 'primative',
    array = 'array',
    function = 'function',
    object = 'object'
}

export interface EvaluateContainer {
    name: string;
    evaluateName: string;
    type: string;
    value: string;
    highLevelType: HighLevelType;
    children: EvaluateContainer[];
}

export interface Thread {
    isSelected: boolean;
    lineNumber: number;
    filePath: string;
    lineContents: string;
    threadId: number;
}

export enum PrimativeType {
    invalid = 'Invalid',
    boolean = 'Boolean',
    string = 'String',
    integer = 'Integer',
    float = 'Float'
}

export class RequestPipeline {
    constructor(
        private client: Socket
    ) {
        this.connect();
    }
    private requests: RequestPipelineRequest[] = [];
    private get isProcessing() {
        return this.currentRequest !== undefined;
    }
    private currentRequest: RequestPipelineRequest = undefined;

    private emitter = new EventEmitter();

    on(eventName: 'unhandled-data', handler: (data: string) => void)
    public on(eventName: string, handler: (data: string) => void) {
        this.emitter.on(eventName, handler);
        return () => {
            this.emitter.removeListener(eventName, handler);
        };
    }

    private emit(eventName: 'unhandled-data', data: string) {
        this.emitter.emit(eventName, data);
    }

    private connect() {
        let allResponseText = '';
        this.client.addListener('data', (responseText: string) => {
            allResponseText += responseText;

            //if we are not processing, immediately broadcast the latest data
            if (!this.isProcessing) {
                this.emit('unhandled-data', allResponseText);
                allResponseText = '';
            }
            //we are processing. detect if we have reached a prompt. 
            else {
                var match;
                //if responseText produced a prompt, return the responseText
                if (match = /Brightscript\s+Debugger>\s+$/i.exec(allResponseText)) {
                    //resolve the command's promise (if it cares)
                    this.currentRequest.onComplete(allResponseText);
                    allResponseText = '';
                    this.currentRequest = undefined;
                    //try to run the next request
                    this.process();
                }
            }

        });
    }

    /**
     * Schedule a command to be run. Resolves with the result once the command finishes
     * @param commandFunction
     * @param waitForPrompt - if true, the promise will wait until we find a prompt, and return all output in between. If false, the promise will immediately resolve
     */
    public executeCommand(command: string, waitForPrompt: boolean) {
        return new Promise<string>((resolve, reject) => {
            let executeCommand = () => {
                this.client.write(`${command}\r\n`);
            };
            this.requests.push({
                executeCommand,
                onComplete: resolve,
                waitForPrompt
            });
            //start processing (safe to call multiple times)
            this.process();
        });
    }

    /**
     * Internall request processing function
     */
    private async process() {
        if (this.isProcessing || this.requests.length === 0) {
            return;
        }
        //get the oldest command
        let nextRequest = this.requests.shift();
        if (nextRequest.waitForPrompt) {
            this.currentRequest = nextRequest;
        } else {
            //fire and forget the command
        }

        //run the request. the data listener will handle launching the next request once this one has finished processing
        nextRequest.executeCommand();

        //if the command doesn't care about the output, resolve it immediately
        if (!nextRequest.waitForPrompt) {
            nextRequest.onComplete(undefined);
        }
    }

    public destroy() {
        this.client.removeAllListeners();
        this.client.destroy();
        this.client = undefined;
    }
}

interface RequestPipelineRequest {
    executeCommand: () => void;
    onComplete: (data: string) => void;
    waitForPrompt: boolean;
}