import { StreamChat } from 'stream-chat';
import crypto from 'crypto';

const LayerChat = require('../src/client');

const STREAM_CHAT_TYPE = 'messaging';

function getUUIDFromURL(url) {
	const parts = url.split('/');

	if (parts.length) {
		return parts[parts.length - 1];
	}
}

/**
 * getStreamClient - returns the Stream Chat client
 *
 * @returns {object}  Stream chat client
 */
function getStreamClient() {
	if (!process.env.STREAM_API_KEY) {
		throw Error('Environment variable STREAM_API_KEY is not defined!');
	}

	if (!process.env.STREAM_API_SECRET) {
		throw Error('Environment variable STREAM_API_SECRET is not defined!');
	}

	const client = new StreamChat(
		process.env.STREAM_API_KEY,
		process.env.STREAM_API_SECRET
	);

	return client;
}

function convertUser(data) {
	// TODO: handle the extra fields...
	return { id: data.message.sender.user_id };
}

function convertPartToAttachment(part) {
	// TODO: Support Content system
	// Lot of flexibility in terms of message types...
	// https://docs.layer.com/xdk/webxdk/messages#message-parts
	// https://docs.layer.com/reference/webhooks/message.obj#messages
	const t = part.mime_type;

	// start by simply copying the part data
	let attachment = Object.assign({}, part);

	if (t === 'application/json') {
		// some layer customers store json in the parts
		attachment = Object.assign(attachment, JSON.parse(part.body));
	} else if (t.indexOf('image') !== -1) {
		// support the content style part https://docs.layer.com/reference/webhooks/message.obj#messages
		if (part.content) {
			attachment.type = 'image';
			attachment.thumb_url = part.content.download_url;
		}
	}

	return attachment;
}

function convertMessage(data, user) {
	// TODO: Verify we handle all edge cases with message parts
	const parts = data.message.parts;
	const message = data.message;
	const messageUUID = getUUIDFromURL(message.id);

	let text = '';
	if (parts[0].mime_type === 'text/plain') {
		text = parts[0].body;
	}

	const attachments = [];
	for (const part of parts) {
		if (part.mime_type !== 'text/plain') {
			attachments.push(convertPartToAttachment(part));
		}
	}

	const streamMessage = {
		id: messageUUID,
		user,
		text,
		attachments,
	};

	return streamMessage;
}
async function convertChannel(data) {
	// TODO: handle distinct..
	// https://docs.layer.com/sdk/web/conversations#distinct-conversations
	//
	// TODO: handle createdBy
	const conversationURL = data.message.conversation.id;
	const conversationUUID = conversationURL.split('/')[
		conversationURL.split('/').length - 1
	];

	const l = LayerChat.LayerClientFromEnv();

	const conversation = await l.conversation(conversationUUID);
	// channels are pretty similar to conversations...
	// metadata needs to be imploded
	// created_at and updated_at are the same
	// id and chat type are different
	const streamChannel = conversation.metadata || {};

	streamChannel.type = STREAM_CHAT_TYPE;

	if (!conversation.distinct) {
		streamChannel.id = '';
	} else {
		streamChannel.id = conversationUUID;
	}

	streamChannel.created_at = conversation.created_at;
	streamChannel.updated_at = conversation.updated_at;
	streamChannel.layer_conversation_id = conversationUUID;
	streamChannel.sync_source = 'webhook';

	const members = [];
	for (const p of conversation.participants) {
		members.push(p.user_id);
	}

	streamChannel.members = members;

	return streamChannel;
}

export const layer = async event => {
	const data = JSON.parse(event.body);

	// - validate the payload
	// - parse the layer webhook event
	// - figure out the corresponding stream channel
	// - convert the message
	// - write the message to Stream

	// Validate the layer webhook data
	// https://docs.layer.com/reference/webhooks/payloads#validating-payload-integrity
	const signature = event.headers['layer-webhook-signature'];

	if (!process.env.WEBHOOK_SECRET) {
		console.log('WEBHOOK_SECRET is not defined!');
	}

	const hmac = crypto.createHmac('sha1', process.env.WEBHOOK_SECRET);

	hmac.update(event.body);

	const correctSignature = hmac.digest('hex');

	if (signature !== correctSignature) {
		return {
			statusCode: 403,
			headers: {
				'Access-Control-Allow-Origin': '*',
			},
			body: JSON.stringify({
				error:
					'Signature was not correct, check your webhook secret and verify the serverless handler uses the same',
			}),
		};
	}

	if (data.event.type !== 'Message.created') {
		return {
			statusCode: 200,
			headers: {
				'Access-Control-Allow-Origin': '*',
			},
			body: JSON.stringify({
				error: 'not able to handle events of this type...',
			}),
		};
	}

	// convert the webhook data
	const channel = await convertChannel(data);
	const user = convertUser(data);
	const message = convertMessage(data, user);

	console.log('converted channel', channel);
	console.log('converted user', user);
	console.log('converted message', message);

	const chatClient = getStreamClient();

	const users = channel.members.map(member => ({
		id: member,
		role: 'user',
	}));

	await chatClient.updateUsers(users);

	const streamChannel = chatClient.channel(channel.type, channel.id, {
		layer_conversation_id: channel.layer_conversation_id,
		members: channel.members,
		created_by: {
			id: channel.sync_source,
			name: 'Stream Layer Sync',
		},
	});

	await streamChannel.create();
	await streamChannel.sendMessage(message);

	return {
		statusCode: 200,
		headers: {
			'Access-Control-Allow-Origin': '*',
		},
		body: JSON.stringify({ data }),
	};
};

export const verify = async event => ({
	statusCode: 200,
	headers: {
		'Access-Control-Allow-Origin': '*',
	},
	body: event.queryStringParameters.verification_challenge,
});
