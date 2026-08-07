'use strict';

const { Notification } = require('electron');

const OFFLINE_MESSAGE = 'No Internet Available. Treelife Drive requires internet to read/write files.';

class Notifications {
  /**
   * Show an OS notification.
   * @param {string} title
   * @param {string} body
   * @param {'normal'|'critical'} urgency
   */
  notify(title, body, urgency = 'normal') {
    if (!Notification.isSupported()) return;

    const notification = new Notification({
      title,
      body,
      urgency,
    });

    notification.show();
  }

  /**
   * Notify user that internet connection is unavailable.
   */
  notifyOffline() {
    this.notify(
      'No Internet Available',
      'Treelife Drive requires internet to read/write files.',
      'critical'
    );
  }

  /**
   * Notify user that internet connection has been restored.
   */
  notifyOnline() {
    this.notify(
      'Connected',
      'Treelife Drive is back online and syncing.',
      'normal'
    );
  }

  /**
   * Notify user that a file upload/sync error occurred.
   * @param {string} filename
   * @param {string} reason
   */
  notifyUploadError(filename, reason) {
    this.notify(
      'Sync Error',
      `${filename}: ${reason}`,
      'critical'
    );
  }

  /**
   * Notify user that they do not have access to a file.
   * @param {string} filename
   */
  notifyNoAccess(filename) {
    this.notify(
      'No Access',
      `You do not have permission to access: ${filename}. Visit drive.treelife.co to request access.`,
      'critical'
    );
  }

  /**
   * Notify user that sync completed successfully.
   * Only shows if count > 0.
   * @param {number} count
   */
  notifySyncComplete(count) {
    if (count <= 0) return;

    this.notify(
      'Sync Complete',
      `${count} file${count === 1 ? '' : 's'} synced.`,
      'normal'
    );
  }

  /**
   * Notify user that a sync conflict was detected.
   * @param {string} filename
   */
  notifyConflict(filename) {
    this.notify(
      'Conflict Detected',
      filename,
      'critical'
    );
  }
}

module.exports = { Notifications, OFFLINE_MESSAGE };
