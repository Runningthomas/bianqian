'use strict';
const { contextBridge, ipcRenderer } = require('electron');

// 桌面版的 window.api 实现。契约与 web/api.js 里的网页版实现保持一致，
// 上层 app.js 只认这套接口，两端共用同一份界面代码。
contextBridge.exposeInMainWorld('api', {
  isDesktop: true,
  runtime: 'desktop',

  // 数据
  loadState: () => ipcRenderer.invoke('state:load'),
  saveNote: (note) => ipcRenderer.invoke('note:save', note),
  deleteNote: (id) => ipcRenderer.invoke('note:delete', id),
  exportData: () => ipcRenderer.invoke('data:export'),
  importData: () => ipcRenderer.invoke('data:import'),

  // 设置
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),

  // 窗口控制
  winMinimize: () => ipcRenderer.invoke('win:minimize'),
  winMaximize: () => ipcRenderer.invoke('win:maximize'),
  winClose: () => ipcRenderer.invoke('win:close'),

  // 同步
  syncNow: () => ipcRenderer.invoke('sync:now'),
  getSyncStatus: () => ipcRenderer.invoke('sync:status'),
  createGist: (token) => ipcRenderer.invoke('gist:create', token),
  onSyncStatus: (cb) => ipcRenderer.on('sync:status', (_e, s) => cb(s)),
  pickFolder: () => ipcRenderer.invoke('dialog:pickFolder'),
  clipboardWrite: (text) => ipcRenderer.invoke('clipboard:writeText', text),
  clipboardRead: () => ipcRenderer.invoke('clipboard:readText'),

  // 主进程推送
  onStateChanged: (cb) => ipcRenderer.on('state:changed', (_e, s) => cb(s)),
  onSettingsChanged: (cb) => ipcRenderer.on('settings:changed', (_e, s) => cb(s)),
  onReminder: (cb) => ipcRenderer.on('note:reminder', (_e, p) => cb(p)),
  onAction: (cb) => ipcRenderer.on('action:new-note', () => cb()),
  onOpenSettings: (cb) => ipcRenderer.on('action:open-settings', () => cb()),

  // 速记小窗
  quickSave: (text) => ipcRenderer.invoke('quick:save', text),

  // 打开网页（注册/获取应用密码等）
  openExternal: (url) => ipcRenderer.invoke('shell:openExternal', url),

  // 版本与更新
  getVersion: () => ipcRenderer.invoke('app:version'),
  checkUpdate: () => ipcRenderer.invoke('app:check-update'),
});