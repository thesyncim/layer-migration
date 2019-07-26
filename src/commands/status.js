const { Command } = require('@oclif/command');

const LayerChat = require('../../client');

function timeout(delayms) {
	return new Promise(function(resolve) {
		setTimeout(resolve, delayms);
	});
}

class StatusCommand extends Command {
	async run() {
		const l = new LayerChat(
			process.env.LAYER_APP_ID,
			process.env.LAYER_TOKEN
		);

		while (true) {
			const res = await l.exports();
			this.log(res);
			await timeout(5000);
		}
	}
}

StatusCommand.description =
	"displays the status of the layer export – note that layer will also send you an email when it's done";

module.exports = StatusCommand;
