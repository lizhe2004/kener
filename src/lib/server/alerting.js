// @ts-nocheck
import notification from "./notification/notif.js";
import { ParseIncidentPayload, GHIssueToKenerIncident } from "./webhook.js";
import {
	CreateIssue,
	GetIncidentByNumber,
	UpdateIssueLabels,
	AddComment,
	CloseIssue
} from "./github.js";
import moment from "moment";
import { GetAllSiteData, GetGithubData, GetAllTriggers } from "./controllers/controller.js";

import db from "./db/db.js";

const TRIGGERED = "TRIGGERED";
const RESOLVED = "RESOLVED";

async function createJSONCommonAlert(monitor, config, alert) {
	let siteData = await GetAllSiteData();
	let siteURL = siteData.siteURL;
	let id = monitor.tag + "-" + alert.id;
	let alert_name = monitor.name + " " + alert.monitorStatus;
	let severity = alert.monitorStatus === "DEGRADED" ? "warning" : "critical";
	let source = "Kener";
	let timestamp = new Date().toISOString();
	let description = config.description || "Monitor has failed";
	let status = alert.alertStatus;
	let details = {
		metric: monitor.name,
		current_value: alert.healthChecks,
		threshold: config.failureThreshold
	};
	let actions = [
		{
			text: "View Monitor",
			url: siteURL + "/monitor-" + monitor.tag
		}
	];
	return {
		id,
		alert_name,
		severity,
		status,
		source,
		timestamp,
		description,
		details,
		actions
	};
}

async function createGHIncident(monitor, alert, commonData) {
	let payload = {
		startDatetime: moment(alert.createAt).unix(),
		title: commonData.alert_name,
		tags: [monitor.tag],
		impact: alert.monitorStatus,
		body: commonData.description,
		isIdentified: true
	};

	let description = commonData.description;
	description =
		description +
		`\n\n ### Monitor Details \n\n - Monitor Name: ${monitor.name} \n- Incident Status: ${commonData.status} \n- Severity: ${commonData.severity} \n - Monitor Status: ${alert.monitorStatus} \n - Monitor Health Checks: ${alert.healthChecks} \n - Monitor Failure Threshold: ${commonData.details.threshold} \n\n ### Actions \n\n - [${commonData.actions[0].text}](${commonData.actions[0].url}) \n\n`;

	payload.body = description;

	let { title, body, githubLabels, error } = ParseIncidentPayload(payload);
	if (error) {
		return;
	}

	githubLabels.push("auto");
	let resp = await CreateIssue(title, body, githubLabels);

	return GHIssueToKenerIncident(resp);
}

async function closeGHIncident(alert) {
	let incidentNumber = alert.incidentNumber;
	let issue = await GetIncidentByNumber(incidentNumber);
	if (issue === null) {
		return;
	}
	let labels = issue.labels.map((label) => {
		return label.name;
	});
	labels = labels.filter((label) => label !== "resolved");
	labels.push("resolved");

	let endDatetime = moment(alert.updatedAt).unix();
	let body = issue.body;
	body = body.replace(/\[end_datetime:(\d+)\]/g, "");
	body = body.trim();
	body = body + " " + `[end_datetime:${endDatetime}]`;

	let resp = await UpdateIssueLabels(incidentNumber, labels, body);
	if (resp === null) {
		return;
	}
	await CloseIssue(incidentNumber);
	return GHIssueToKenerIncident(resp);
}

//add comment to incident
async function addCommentToIncident(alert, comment) {
	let resp = await AddComment(alert.incidentNumber, comment);
	return resp;
}

function createClosureComment(alert, commonJSON) {
	let comment = "The incident has been auto resolved";
	let downtimeDuration = moment(alert.updatedAt).diff(moment(alert.createdAt), "minutes");
	comment = comment + `\n\nTotal downtime: ` + downtimeDuration + ` minutes`;
	return comment;
}

async function alerting(monitor) {
	let siteData = await GetAllSiteData();
	const githubData = await GetGithubData();
	const triggers = await GetAllTriggers({
		status: "ACTIVE"
	});
	const triggerObj = {};
	if (!!monitor.downTrigger) {
		triggerObj.downTrigger = JSON.parse(monitor.downTrigger);
	}
	if (!!monitor.degradedTrigger) {
		triggerObj.degradedTrigger = JSON.parse(monitor.degradedTrigger);
	}

	for (const key in triggerObj) {
		if (Object.prototype.hasOwnProperty.call(triggerObj, key)) {
			const alertConfig = triggerObj[key];
			const monitorStatus = alertConfig.triggerType;

			const failureThreshold = alertConfig.failureThreshold;
			const successThreshold = alertConfig.successThreshold;
			const monitorTag = monitor.tag;
			const alertingChannels = alertConfig.triggers; //array of numbers of trigger ids
			const createIncident = alertConfig.createIncident === "YES" && !!githubData;
			const allMonitorClients = [];
			const sendTrigger = alertConfig.active;

			if (!sendTrigger) {
				continue;
			}
			if (alertingChannels.length > 0) {
				for (let i = 0; i < alertingChannels.length; i++) {
					const triggerID = alertingChannels[i];
					const trigger = triggers.find((c) => c.id === triggerID);
					if (!trigger) {
						console.error(
							`Triggers ${triggerID} not found in server triggers for monitor ${monitorTag}`
						);
						continue;
					}
					const notificationClient = new notification(trigger, siteData, monitor);
					allMonitorClients.push(notificationClient);
				}
			}

			let isAffected = await db.consecutivelyStatusFor(
				monitorTag,
				monitorStatus,
				failureThreshold
			);
			let alertExists = await db.alertExists(monitorTag, monitorStatus, TRIGGERED);
			let activeAlert = null;
			if (alertExists) {
				activeAlert = await db.getActiveAlert(monitorTag, monitorStatus, TRIGGERED);
			}
			if (isAffected && !alertExists) {
				activeAlert = await db.insertAlert({
					monitorTag: monitorTag,
					monitorStatus: monitorStatus,
					alertStatus: TRIGGERED,
					healthChecks: failureThreshold
				});
				let commonJSON = await createJSONCommonAlert(monitor, alertConfig, activeAlert);
				if (allMonitorClients.length > 0) {
					for (let i = 0; i < allMonitorClients.length; i++) {
						const client = allMonitorClients[i];
						client.send(commonJSON);
					}
				}
				if (createIncident) {
					let incident = await createGHIncident(monitor, activeAlert, commonJSON);

					if (!!incident) {
						//send incident to incident channel
						await db.addIncidentNumberToAlert(activeAlert.id, incident.incidentNumber);
					}
				}
			} else if (isAffected && alertExists) {
				await db.incrementAlertHealthChecks(activeAlert.id);
			} else if (!isAffected && alertExists) {
				let isUp = await db.consecutivelyStatusFor(monitorTag, "UP", successThreshold);
				if (isUp) {
					await db.updateAlertStatus(activeAlert.id, RESOLVED);
					activeAlert.alertStatus = RESOLVED;
					let commonJSON = await createJSONCommonAlert(monitor, alertConfig, activeAlert);
					if (allMonitorClients.length > 0) {
						for (let i = 0; i < allMonitorClients.length; i++) {
							const client = allMonitorClients[i];
							client.send(commonJSON);
						}
					}
					if (!!activeAlert.incidentNumber) {
						let comment = createClosureComment(activeAlert, commonJSON);

						try {
							await addCommentToIncident(activeAlert, comment);
							await closeGHIncident(activeAlert);
						} catch (error) {
							console.log(error);
						}
					}
				}
			}
		}
	}
}

export default alerting;
