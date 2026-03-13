"use strict";
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.main = void 0;
/**
 * Tests a push notification
 */
const prompts_1 = __importDefault(require("prompts"));
const client_sns_1 = require("@aws-sdk/client-sns");
const main = () => __awaiter(void 0, void 0, void 0, function* () {
    // Get Env Keys
    const message = {
        region: process.env.AWS_REGION,
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
        targetARN: process.env.TARGET_ARN
    };
    const values = yield (0, prompts_1.default)([
        { message: 'region', name: 'region', type: 'text', initial: 'us-west-1' },
        {
            message: 'accessKey',
            name: 'accessKey',
            type: 'text',
            initial: message.accessKeyId
        },
        {
            message: 'secret',
            name: 'secret',
            type: 'text',
            initial: message.secretAccessKey
        },
        {
            message: 'type',
            name: 'type',
            type: 'list',
            choices: [
                { title: 'ios', value: 'ios' },
                { title: 'android', value: 'android' }
            ],
            initial: 'ios'
        },
        { message: 'title', name: 'title', type: 'text', initial: 'test message' },
        { message: 'body', name: 'body', type: 'text', initial: 'test body' },
        {
            message: 'targetARN',
            name: 'targetARN',
            type: 'text',
            initial: message.targetARN
        }
    ]);
    const snsClient = new client_sns_1.SNSClient({
        region: values.region,
        credentials: {
            accessKeyId: values.accessKey,
            secretAccessKey: values.secret
        }
    });
    const publish = (params) => __awaiter(void 0, void 0, void 0, function* () {
        try {
            const data = yield snsClient.send(new client_sns_1.PublishCommand(params));
            console.log('sns send success');
            return data; // For unit tests.
        }
        catch (err) {
            console.log('Error', err.stack);
        }
    });
    const ARN = 'APNS';
    const sendIOSMessage = ({ title, body, badgeCount, data, playSound = true, targetARN }) => __awaiter(void 0, void 0, void 0, function* () {
        const message = JSON.stringify({
            ['default']: body,
            [ARN]: JSON.stringify({
                aps: {
                    alert: {
                        title,
                        body
                    },
                    sound: playSound && 'default',
                    badge: badgeCount
                },
                data
            })
        });
        yield publish({
            TargetArn: targetARN,
            Message: message,
            MessageStructure: 'json'
        });
    });
    const sendAndroidMessage = ({ title, body, targetARN, data = {}, playSound = true }) => __awaiter(void 0, void 0, void 0, function* () {
        const message = JSON.stringify({
            default: body,
            GCM: {
                notification: Object.assign(Object.assign({}, (title ? { title } : {})), { body, sound: playSound && 'default' }),
                data
            }
        });
        yield publish({
            TargetArn: targetARN,
            Message: message,
            MessageStructure: 'json'
        });
    });
    Object.entries(values).forEach(([k, v]) => {
        message[k] = message[k] || v;
    });
    console.table(Object.entries(message).map(([k, v]) => ({ key: k, val: v })));
    if (values.type.includes('android')) {
        console.log('sending android notification');
        yield sendAndroidMessage({
            title: values.title,
            body: values.body,
            data: {},
            playSound: true,
            targetARN: values.targetARN
        });
    }
    if (values.type.includes('ios')) {
        console.log('sending ios notification');
        yield sendIOSMessage({
            title: values.title,
            body: values.body,
            badgeCount: 1,
            data: {},
            playSound: true,
            targetARN: values.targetARN
        });
    }
});
exports.main = main;
(0, exports.main)();
