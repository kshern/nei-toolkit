/*
 * NEI Builder
 * @author huntbao
 */
'use strict';
let vm = require('vm');
let util = require('util');
let querystring = require('querystring');
let Handlebars = require('handlebars');
let EventEmitter = require('events');
let Diff = require('./diff');
let _io = require('../util/io');
let _fs = require('../util/file');
let fs = require('fs');
let _path = require('../util/path');
let _util = require('../util/util');
let logger = require('../util/logger');
let mockDataWork = require('../fb-modules/util/mock_data_worker');
let neiDbConst = require('../fb-modules/config/db.json');
let dsUtil = require('./ds.util');
let PbxProj = require('./mobile.oc.pbx.js');
require('./handlebars.util');

const DEFAULT_MOCK_FILTER = ['module.exports = function (json) {', '\treturn json;', '}'].join('\n');
const TEXT_REGEX = /^(text\/.+)|(application\/json)$/;

class Builder extends EventEmitter {
    /**
     * @param  {object} options - 参数
     * @property  {object} options.config - 一些构建工具需要使用的配置参数
     * @property  {object} options.args - 命令行参数
     * @property  {object} options.ds - nei 原始数据源
     */
    constructor(options) {
        super();
        this.options = options;
        this.config = options.config;
        this.args = options.args;
        this.spec = options.ds.specs[0];
        this.ds = dsUtil.format(options.ds);
        // 页面模板mock规则
        this.templateMockRules = [];
        // 渲染模板时传入的数据
        this.data = {
            args: this.args,
            config: {},
            project: this.ds.project,
            spec: this.ds.spec,
            interfaceMockRules: [],
            datatypeEnums: this.ds.datatypeEnums,
            ds: this.ds,
            _ds: options.ds
        };
        delete this.ds.project;
        delete this.ds.spec;
        delete this.ds.datatypeEnums;
        // 先找配置文件
        this.findConfigs();
        // 将一些 config 信息设置到传给模板的数据中
        this.setConfigToData();
        // 是否更新普通文件
        this.shouldUpdateNormalDoc = this.canGenNormalDoc();
        // 先构建mock数据, 因为mock数据的信息需要传给Handlebars模板
        this.diffResult = null;
        if (this.args.key) {
            // diff
            this.diffResult = new Diff(this.config, this.options.ds);
            this.buildInterfaceMock();
            this.buildTemplateMock();
            this.buildViewRules();
        }
        this.buildDocsTree();
        if (this.args.key) {
            // 生成 nei 配置文件
            this.buildNeiConfig();
            // 生成 server 配置文件
            this.buildServerConfig();
            // 更新 ios 项目的工程文件
            if (this.isIosProject()) {
                this.updatePbxFile();
            }
        }

    }

    /**
     * 找配置文件
     */
    findConfigs() {
        let docs = this.spec.docs;
        let spec = this.spec.spec;
        // 目前只有web规范才有这个字段
        if (!spec.hasOwnProperty('attributes')) {
            return;
        }
        let find = (docs, dir) => {
            docs.forEach((doc) => {
                if (doc.type === neiDbConst.SPC_NOD_DIR) {
                    // 目录
                    let filename = Handlebars.compile(doc.name)(this.data);
                    let file = _path.normalize(`${dir}/${filename}/`);
                    switch (doc.id) {
                        case spec.attributes.webRoot:
                            this.config.webRoot = file;
                            break;
                        case spec.attributes.viewRoot:
                            this.config.viewRoot = file;
                            break;
                        case spec.attributes.mockApiRoot:
                            this.config.mockApiRoot = file;
                            break;
                        case spec.attributes.mockViewRoot:
                            this.config.mockViewRoot = file;
                            break;
                        default:
                            break;
                    }
                    find(doc.children, file);
                }
            });
        }
        find(docs, this.config.outputRoot);
    }

    /**
     * 将一些 config 信息设置到传给模板的数据中
     */
    setConfigToData() {
        let config = this.config;
        Object.assign(this.data.config, {
            webRoot: config.webRoot && config.webRoot.replace(this.config.outputRoot, '/'),
            viewRoot: config.viewRoot && config.viewRoot.replace(this.config.outputRoot, '/'),
            mockApiRoot: config.mockApiRoot && config.mockApiRoot.replace(this.config.outputRoot, '/'),
            mockViewRoot: config.mockViewRoot && config.mockViewRoot.replace(this.config.outputRoot, '/')
        });
    }

    /**
     * 生成异步接口的mock数据
     */
    buildInterfaceMock() {
        // 工程结构中没有设置异步接口的mock数据根目录
        if (!this.config.mockApiRoot) {
            return;
        }
        let mockApiRoot = this.config.mockApiRoot;
        let getMockDataPath = (url) => {
            // windows 的文件夹名称不能有特殊字符, 将 url 中的 ": ? & =" 转成 "/_/"
            return _path.normalize(url.replace(/:|\?|&|=/g, '/_/') + '/data');
        };
        this.options.ds.interfaces.forEach((itf)=> {
            let method = itf.method.toLowerCase();
            let url = itf.path;
            let name = getMockDataPath(url);
            let file = _path.normalize(`${mockApiRoot}/${method}/${name}`);
            let mockDataFile = `${file}.json`;
            let result = mockDataWork.getParameterMockData(this.data.ds.constraints, itf.resFormat, itf.params.outputs, this.options.ds.datatypes);
            if (result.error && result.error.length) {
                logger.log("error", {message: result.error.map(err => err.message).join(', ')});
            }
            // 检查 afterScript
            result = mockDataWork.getAfterScriptResult(this.data.ds.constraints, result.json, itf);
            if (result.error && result.error.length) {
                logger.log("error", {message: result.error.map(err => err.message).join(', ')});
            }
            this.output(mockDataFile, JSON.stringify(result.json, null, 4));
            // 输出 mock filter
            let mockFilterFile = `${file}.js`;
            this.output(mockFilterFile, DEFAULT_MOCK_FILTER);
            // 给接口代理工具准备的数据, 比如 fiddler
            this.data.interfaceMockRules.push({
                id: itf.id,
                path: url,
                mockFile: file.replace(this.config.mockApiRoot, '').replace(/^(\/)*/, ''),
                method: method.toUpperCase()
            });
        });
    }

    /**
     * 生成页面模板的mock数据
     */
    buildTemplateMock() {
        // 工程结构中没有设置视图的mock数据根目录
        if (!this.config.mockViewRoot) {
            return;
        }
        this.options.ds.templates.forEach((it)=> {
            let hit = this.ds.templates.find((tpl) => {
                return tpl.path === it.path || it.path + `.${this.data.spec.viewExt}` === tpl.path;
            });
            if (!hit) {
                // 模板没有被页面引用, 不用处理
                return;
            }
            let params = it.params;
            let filename = it.path.replace(/\.[^\/]*?$/, '');
            let file = _path.normalize(`${this.config.mockViewRoot}/${filename}`);
            let mockDataFile = `${file}.json`;
            let result = {};
            if (params && params.length) {
                result = mockDataWork.getParameterMockData(this.data.ds.constraints, neiDbConst.MDL_TYP_NORMAL, params, this.options.ds.datatypes)
            }
            if (result.error && result.error.length) {
                logger.log("error", {message: result.error.map(err => err.message).join(', ')});
            }
            let json = result.json || {};
            // 页面标题
            json.title = json.title || it.name;
            // 页面描述
            json.description = json.description || it.description;
            this.output(mockDataFile, JSON.stringify(json, null, 4));
            // 输出 mock filter
            let mockFilterFile = `${file}.js`;
            this.output(mockFilterFile, DEFAULT_MOCK_FILTER);
        });
    }

    /**
     * 生成视图路由规则
     */
    buildViewRules() {
        this.options.ds.pages && this.options.ds.pages.forEach((item) => {
            let tpls = item.templates;
            if (!item.path || !tpls || !tpls.length) {
                return;
            }
            let tplList = tpls.map((tpl) => {
                return {
                    id: tpl.id,
                    path: dsUtil.getFileNameByPath(tpl.path)
                }
            });
            this.templateMockRules.push({
                method: 'GET',
                path: item.path,
                list: JSON.stringify(tplList),
                name: item.name
            });
        });
    }

    /**
     * 生成工程规范文件
     */
    buildDocsTree() {
        let docs = this.spec.docs;
        let genFiles = (ds, itemName, doc, dir) => {
            ds.forEach((item) => {
                let data = Object.assign({}, this.data);
                data[itemName] = item;
                let filename = compileInVm(doc.name, data);
                if (filename.trim() === '') {
                    return logger.log('debug', {
                        message: `文件 ${doc.name} 的计算值为空字符串, 不生成`
                    });
                }
                let file = _path.normalize(`${dir}/${filename}`);
                let content = compileInVm(doc.content || '', data);
                this.output(file, content);
            });
        };
        /**
         * 将datasource为5的加入到vm中，此处，对于这些文件并不下载，而是和后面其他文件统一下载
         * @param docs
         */
        let importCustomHandleBarHelper = function (docs) {
            //todo 加入异常捕获
            let helpersFunc = function (docs, result) {
                docs.forEach(doc=> {
                    if (doc.type === neiDbConst.SPC_NOD_FILE && doc.dataSource === neiDbConst.SPC_DTS_HANDLEBAR) {
                        result.push(doc)
                    } else if (doc.type !== neiDbConst.SPC_NOD_FILE) {
                        helpersFunc(doc.children, result)
                    }
                });
            }
            let helpers = [];
            helpersFunc(docs, helpers);
            let sandbox = {Handlebars, neiDbConst, console};
            let newVmContext = new vm.createContext(sandbox);
            helpers.forEach((helper)=> {
                try {
                    let script = new vm.createScript(helper.content);
                    script.runInContext(newVmContext);//在vm中运行
                } catch (e) {
                    logger.log('error', {message: `自定义文件${helper.name} 包含错误: ${e}`});
                }
            });
            return newVmContext;
        };
        /**
         *
         * @param context
         */
        let compileInVm = function (content, data) {
            let newContext = Object.assign({}, this._vmContext);
            newContext['__data__'] = data;
            newContext['__content__'] = content;
            try {
                let script = vm.createScript(`Handlebars.compile(__content__)(__data__)`);
                return script.runInNewContext(newContext);
            } catch (e) {
                logger.log('error', {message: `生成文件错误: ${e}`});
            }
        }.bind(this);
        this._vmContext = importCustomHandleBarHelper(docs); //导入用户定义的handlebar函数
        let isIOSInterfaceDirRemoved = false;
        let isIOSDatatypeDirRemoved = false;
        let genDocs = (docs, dir) => {
            docs.forEach((doc) => {
                if (doc.type === neiDbConst.SPC_NOD_FILE) {
                    // 先判断文件是否是非文本
                    if (!TEXT_REGEX.test(doc.mime) && this.shouldUpdateNormalDoc) {
                        let filename = compileInVm(doc.name, this.data);
                        let file = _path.normalize(`${dir}/${filename}`);
                        // 考虑到需要下载的文件体积有可能比较大, 它不受 overwrite 参数控制, 如果需要重新下载, 则用户需要先在本地将它删除
                        if (_fs.exist(file)) {
                            return logger.log('debug', {
                                message: `文件已存在, 不下载: ${file}`
                            });
                        }
                        // 如果事先不创建文件夹, 在下载文件的时候偶尔会报错
                        try {
                            logger.log('debug', {
                                message: `创建文件夹: ${dir}`
                            });
                            _fs.mkdir(dir);
                        } catch (e) {
                            logger.log('error', {
                                message: `创建文件夹异常: ${e}`
                            });
                        }
                        return _io.downloadFile(doc.content, file);
                    }
                    // 文件
                    switch (doc.dataSource) {
                        case neiDbConst.SPC_DTS_HANDLEBAR:
                            //Handlebars函数不生成
                            break;
                        case neiDbConst.SPC_DTS_NONE:
                            if (this.shouldUpdateNormalDoc) {
                                // 普通文件, 没有数据源
                                let filename = compileInVm(doc.name, this.data);
                                if (filename.trim() === '') {
                                    logger.log('debug', {
                                        message: `文件 ${doc.name} 的计算值为空字符串, 不生成`
                                    });
                                    break;
                                }
                                let file = _path.normalize(`${dir}/${filename}`);
                                let content = doc.content;
                                content = compileInVm(content, this.data);
                                this.output(file, content);
                            }
                            break;
                        case neiDbConst.SPC_DTS_INTERFACE:
                            // 如果是iOS项目并且接口或者数据模型有变化, 则把已有的接口都先删除, 然后再创建这个目录
                            if (this.isIosProject() && (this.diffResult.interfaceChanged || this.diffResult.datatypeChanged) && !isIOSInterfaceDirRemoved) {
                                logger.log('debug', {
                                    message: `删除接口文件夹: ${dir}/`
                                });
                                _fs.rmdir(`${dir}/`);
                                _fs.mkdir(`${dir}/`);
                                isIOSInterfaceDirRemoved = true;
                            }
                            // 以异步接口列表为数据源填充
                            if (this.config.pbxUpdateDir === undefined) {
                                this.config.pbxUpdateDir = [dir]
                            } else if (this.config.pbxUpdateDir.findIndex(x=>x === dir) === -1) {
                                this.config.pbxUpdateDir.push(dir);
                            }
                            genFiles(this.ds.interfaces, 'interface', doc, dir);
                            break;
                        case neiDbConst.SPC_DTS_DATATYPE:
                            // 如果是iOS项目并且接口或者数据模型有变化, 则把已有的数据模型都先删除, 然后再创建这个目录
                            if (this.isIosProject() && (this.diffResult.interfaceChanged || this.diffResult.datatypeChanged) && !isIOSDatatypeDirRemoved) {
                                logger.log('debug', {
                                    message: `删除数据模型文件夹: ${dir}/`
                                });
                                _fs.rmdir(dir + '/');
                                _fs.mkdir(dir + '/');
                                isIOSDatatypeDirRemoved = true;
                            }
                            // 以数据模型列表为数据源填充
                            if (this.config.pbxUpdateDir === undefined) {
                                this.config.pbxUpdateDir = [dir];
                            } else if (this.config.pbxUpdateDir.findIndex(x=>x === dir) === -1) {
                                this.config.pbxUpdateDir.push(dir);
                            }
                            if (doc.name && (doc.name.search('!!enum') != -1)) {
                                doc.name = doc.name.replace(/!!enum/g, '');
                                genFiles(this.data.datatypeEnums, 'datatype', doc, dir);
                            } else {
                                genFiles(this.ds.datatypes, 'datatype', doc, dir);
                            }
                            break;
                        case neiDbConst.SPC_DTS_TEMPLATE:
                            // 以页面模板列表为数据源填充
                            genFiles(this.ds.templates, 'template', doc, dir);
                            break;
                        case neiDbConst.SPC_DTS_WEBVIEW:
                            // 以页面列表为数据源填充
                            genFiles(this.ds.pages, 'view', doc, dir);
                            break;
                        default:
                            break;
                    }
                } else {
                    // 目录
                    let filename = compileInVm(doc.name, this.data);
                    let file = _path.normalize(`${dir}/${filename}`);
                    _fs.mkdir(file);
                    genDocs(doc.children, file);
                }
            });
        }
        genDocs(docs, this.config.outputRoot);
    }

    /**
     * 生成 nei 配置文件
     */
    buildNeiConfig() {
        if (/^(build|update)$/.test(this.config.action)) {
            let file = `${this.config.neiConfigRoot}nei.json`;
            let args = {
                specType: this.args.specType,
                pid: this.config.pid
            };
            if (this.args.key)
                args.key = this.args.key;
            if (this.args.specKey)
                args.specKey = this.args.specKey;
            if (this.args.iosProjectPath)
                args.iosProjectPath = this.args.iosProjectPath;
            this.output(file, JSON.stringify({
                args
            }, null, 4), true);
        }
    }

    /**
     * 生成 nei server 配置文件
     */
    buildServerConfig() {
        let jtrConfigTpl = _fs.read(`${__dirname}/template/server.config.js.tpl`).join('\n');
        let rules = this.templateMockRules.concat(this.data.interfaceMockRules);
        // 按 rules 的 path 字段进行排序, 参数多的排前面, 使得优先匹配
        rules.sort((rule1, rule2) => {
            return rule1.path > rule2.path ? -1 : 1;
        });
        let neiServerConfigFilePath = `${this.config.neiConfigRoot}server.config.js`;
        let neiServerConfig = {
            launch: true,
            port: 8002,
            online: false
        };
        if (this.config.action === 'update') {
            // 更新的时候，launch、port、online、fmpp、apiResHeaders 参数需要保留，因为这些参数非常可能是用户仍旧希望保留的
            let existNeiServerConfig = _util.file2json(neiServerConfigFilePath);
            ['launch', 'port', 'online', 'fmpp', 'apiResHeaders'].forEach((property) => {
                if (existNeiServerConfig.hasOwnProperty(property)) {
                    neiServerConfig[property] = existNeiServerConfig[property];
                }
            });
        }
        let data = Object.assign({}, this.config, {
            engine: this.data.spec.engine,
            viewExt: this.data.spec.viewExt,
            rules: rules,
            projectKey: this.args.key
        }, neiServerConfig);
        let content = Handlebars.compile(jtrConfigTpl)(data);
        this.output(neiServerConfigFilePath, content, true);
    }

    /**
     * // 更新 ios 项目的工程文件
     */
    updatePbxFile() {
        let productName = null;
        let condition1 = this.config.action === "build"; //build时要更新
        let condition2 = this.config.action === "update" && (this.diffResult.datatypeChanged || this.diffResult.interfaceChanged); //数据有更新
        let condition3 = this.isIosProject();// 一定是ios工程
        let condition4 = this.config.action === "update" && this.options.args.pbxForce; // 如果更新时，指定强制更新，也应该更新
        if (condition3 && (condition1 || condition2 || condition4)) {
            // 更新pbxproj文件(xcode 工程)
            let iosProjectPath = this.args.iosProjectPath || this.config.outputRoot;
            iosProjectPath = _path.absolutePath(iosProjectPath, this.config.outputRoot);
            let fileList = fs.readdirSync(iosProjectPath);
            fileList.find((filename) => {
                if (filename.endsWith('.xcodeproj')) {
                    productName = filename.split('.')[0];
                    return true;
                }
            });

            if (!productName) {
                return logger.log('info', {
                    message: `Can't find .xcodeproj file to update`
                });
            }
            let projectPath = _path.normalize(iosProjectPath + productName);
            let projectFilePath = _path.normalize(projectPath + '.xcodeproj/project.pbxproj');
            // check if pbxproj file exists
            if (_fs.exist(projectFilePath)) {
                let pbxProj = new PbxProj(productName, projectPath, projectFilePath);
                pbxProj.update(this.config.pbxUpdateDir);
            } else {
                logger.log('info', {
                    message: `无pbx文件，无需更新`
                });
            }
        } else {
            logger.log('info', {
                message: `接口和数据类型未更新,不需更新工程`
            });
        }
    }

    /**
     * 在使用 nei update 命令更新项目时, 是否可以更新普通文件和文件夹
     */
    canGenNormalDoc() {
        return this.config.action === 'build' || (this.config.action === 'update') && this.args.spec;
    }

    /**
     * 是否是 iOS 项目
     */
    isIosProject() {
        return this.options.args.specType === 'ios';
    }

    /**
     * 同步写文件
     * @param  {string} file - 文件完整路径, 包括文件名
     * @param  {string} content - 文件内容
     * @param  {boolean} [ignoreCheck] - 是否忽略检查文件是否已经存在
     */
    output(file, content, ignoreCheck) {
        let overWrite = this.args.overwrite;
        let option = file.match(/!!([wW]|n[wW])/g);
        if (option && option.length) {
            option = option[0].toLowerCase();
            file = file.replace(/!!(w|nw)/g, '');
            if (option == '!!w') {
                overWrite = true;
            } else if (option === '!!nw') {
                overWrite = false;
            }
        }
        if (!ignoreCheck && _fs.exist(file) && !overWrite) {
            return logger.log('debug', {
                message: `文件已存在, 不覆盖: ${file}`
            });
        }
        _io.outputSync(file, content);
        logger.log('debug', {
            data: [file],
            message: '输出: %s'
        });
    }
}

module.exports = Builder;

