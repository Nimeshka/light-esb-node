var objectMapper = require('object-mapper');
var uuidGenerator = require('node-uuid');
var util = require('./util')
var RESTClient = require('node-rest-client').Client;
var clone = require('clone');

/**
 * Represents a message being processed by components.
 * 
 * @param   {object}    payload  - The payload of the message
 * @type {function}
 */
var ESBMessage = function(payload, callerUser, callerSystem, callerCorrelationId){
    this.payload = payload;
    this.context = {
        createdTimestamp: Date.now(),
        correlationId: uuidGenerator.v4(),
        caller: {
            user: callerUser,
            system: callerSystem,
            correlationId: callerCorrelationId
        }
    };
    this.originalPayload = clone(payload);
    this.vars = {};
}

function createMessage(payload,callerUser, callerSystem, callerCorrelationId)
{
    
    //var component = new ESBComponent(function(){});
    var message = new ESBMessage(payload,callerUser, callerSystem, callerCorrelationId);       
    return message;
}


/**
 * Represents a base component processing Message.
 * 
 * @param   {function}    fn  - The function that will be invoked when processing Message.
 * @type {function}
 */
var ESBComponent = function(fn, callback){    
    this.fn = fn;
    this.id = uuidGenerator.v4();
    this.channels = { };
    this.callback = callback;
}

ESBComponent.prototype.next = function (name, message) {
    if (arguments.length == 1) {
        message = name;
        name = 'default';
    }
    if(this.channels[name]){
        var self = this;
        this.channels[name].forEach(function (channel) {    
            util.debugMessage('Component %o passing message %o to next component %o using channel %o', self, message, channel, name);         
            channel.send(message) 
        });
    }
};

ESBComponent.prototype.connect = function (channel, component) {
    if (arguments.length == 1) {
        component = channel;
        channel = 'default';
    }
    
    if (!this.channels[channel])
        this.channels[channel] = [];
        
    this.channels[channel].push(component);
    util.debugComponent('Component %o connected component %o at channel %s', this, component, channel);
};

ESBComponent.prototype.send = function (message) {
    util.debugComponent('Component: %o started processing message: %s', this, message.context.correlationId);
    try{
        this.fn(this.context, message);
    } 
    catch (error){
        var errorInfo = {
            component: this,
            message: message,
            cause: error
        };
        this.callback(errorInfo);
    }
};

ESBComponent.prototype.post = function (message) {
    util.debugComponent('Component: %o started processing message: %s in post mode.', this, message.context.correlationId);
    var self = this;
    setImmediate(function () { self.send(message); });
};

//--------- ESB Logger Component
/**
 * Represents a LoggerComponent that writes to the console contents of the message.
 * 
 * @type {function}
 */
var ESBLoggerComponent = function(callback){    
    ESBComponent.call(this,function(context,message){
        this.next(message);
    },callback);
}

ESBLoggerComponent.prototype = new ESBComponent(function(){});
ESBLoggerComponent.prototype.constructor = ESBLoggerComponent;
ESBLoggerComponent.prototype.send = function (message) {
    console.log("LoggerComponent["+this.id+"] processing message:\n", message);
    ESBComponent.prototype.send.call(this,message);
};

function createLoggerComponent(callback)
{
    
    //var component = new ESBComponent(function(){});
    var component = new ESBLoggerComponent(callback);       
    return component;
}


//--------- ESB Mapper Component
/**
 * Represents a MapperComponent processing Message.
 * Mapper component can alter Message contents using object-mapper based transformation maps.
 * 
 * @param   {object}    map  - The map object that will be used by object-mapper to transform Message.
 * @type {function}
 */
var ESBMapperComponent = function(map){ 
    // component fields
    this.map = map;

    // initialize component behaviour   
    ESBComponent.call(this,function(context,message){
        var source = message.payload;
        var resultPayload = objectMapper(source, this.map);
        util.debugMessage('Component %o processed map %o on source %o with result %o', this, this.map, source, resultPayload);      
        message.payload = resultPayload  
        this.next(message);
    });
    
}

ESBMapperComponent.prototype = new ESBComponent(function(){});
ESBMapperComponent.prototype.constructor = ESBMapperComponent;

function createMapperComponent(map)
{
    
    //var component = new ESBComponent(function(){});
    var component = new ESBMapperComponent(map);       
    return component;
}

//--------- ESB Sleep Component
/**
 * Represents a SleepComponent processing Message.
 * Sleep component stops message processing for a given number of miliseconds.
 * 
 * @param   {int}    miliseconds  - The number of miliseconds for which the Message processing will be hold.
 * @type {function}
 */
var ESBSleepComponent = function(miliseconds){ 
    // component fields
    this.sleepMiliseconds = miliseconds;

    // initialize component behaviour   
    ESBComponent.call(this,function(context,message){
        var self = this;
        util.debugMessage('Component %o sleeping for %s with message %o', self, self.sleepMiliseconds, message);      
        setTimeout(function(){
                
            self.next(message);
        },this.sleepMiliseconds);        
    });    
}

ESBSleepComponent.prototype = new ESBComponent(function(){});
ESBSleepComponent.prototype.constructor = ESBSleepComponent;


function createSleepComponent(miliseconds)
{
    
    //var component = new ESBComponent(function(){});
    var component = new ESBSleepComponent(miliseconds);       
    return component;
}

//--------- ESB Vars Component
/**
 * Represents a VarSetComponent processing Message.
 * VarSet component either stores the current message payload under given name.
 * 
 * @param   {string}    variableName  - Name of the vars variable under which current message payload will be stored.
 * @type {function}
 */
var ESBVarSetComponent = function(variableName){ 
    // component fields
    this.variableName = variableName;

    // initialize component behaviour   
    ESBComponent.call(this,function(context,message){
        var self = this;        
        message.vars[this.variableName] = clone(message.payload);
        util.debugMessage('Component %o stored payload %o under variable %s', self, message.vars[this.variableName] , this.variableName);      
        self.next(message);
    });    
}

ESBVarSetComponent.prototype = new ESBComponent(function(){});
ESBVarSetComponent.prototype.constructor = ESBVarSetComponent;

/**
 * Represents a VarGetComponent processing Message.
 * VarGetet component either stores the current message payload under given name.
 * 
 * @param   {string}    variableName  - Name of the vars variable which contents will be put into the message payload. 
 * @type {function}
 */
var ESBVarGetComponent = function(variableName){ 
    // component fields
    this.variableName = variableName;

    // initialize component behaviour   
    ESBComponent.call(this,function(context,message){
        var self = this;   
        if(message.vars[this.variableName]){
            message.payload = clone(message.vars[this.variableName]);
        }     
        //message.vars[this.variableName] = message.payload;
        util.debugMessage('Component %o restored payload %o from variable %s', self, message.payload , this.variableName);      
        self.next(message);
    });    
}

ESBVarGetComponent.prototype = new ESBComponent(function(){});
ESBVarGetComponent.prototype.constructor = ESBVarGetComponent;


function createVarComponent(variableName, operation)
{
    var component;

    if(operation.toUpperCase()=='SET'){
        component = new ESBVarSetComponent(variableName);
    }else{
        component = new ESBVarGetComponent(variableName);
    }        
    return component;
}

//--------- ESB Combine Component
/**
 * Represents a CombineComponent processing Message.
 * Combine component merges contets of the given variable into the current message payload.
 * 
 * @param   {string}    variableName  - Name of the vars variable which contents will be merged into to the message payload.
 * @type {function}
 */
var ESBCombineComponent = function(variableName){ 
    // component fields
    this.variableName = variableName;

    // initialize component behaviour   
    ESBComponent.call(this,function(context,message){
        var self = this;    

        var parialPayload = {};
        if(message.vars[this.variableName]){
            parialPayload = message.vars[this.variableName];
        }
        Object.assign(message.payload, parialPayload);
        
        util.debugMessage('Component %o combined message payload with variable %s resulting in %o', self, message.vars[this.variableName] , message.payload);      
        self.next(message);
    });    
}

ESBCombineComponent.prototype = new ESBComponent(function(){});
ESBCombineComponent.prototype.constructor = ESBCombineComponent;


function createCombineComponent(variableName)
{
    var component = new ESBCombineComponent(variableName);
    return component;
}

//--------- ESB Rest Component
/**
 * Represents a CallComponent processing Message.
 * Call component invokes external component (be it third party REST service).
 * 
 * @param   {string}    variableName  - Name of the vars variable which contents will be merged into to the message payload.
 * @type {function}
 */
var ESBCallComponent = function(callback, requestURL, method, pathArguments){ 
    // component fields    
    this.URL = requestURL;
    this.method = method;
    this.pathArguments = pathArguments;
    

    // initialize component behaviour   
    ESBComponent.call(this,function(context,message){
        var self = this;                      
        var options = {
            // path: { "id": 120 },
            // parameters: { arg1: "hello", arg2: "world" },
            headers: { "Content-Type": "application/json" },
            // data: "<xml><arg1>hello</arg1><arg2>world</arg2></xml>",
            // proxy configuration 
            // proxy: {
            //     host: "proxy.foo.com", // proxy host 
            //     port: 8080, // proxy port 
            //     user: "ellen", // proxy username if required 
            //     password: "ripley" // proxy pass if required 
            // },
            // aditional connection options passed to node http.request y https.request methods  
            // (ie: options to connect to IIS with SSL)  
            // connection: {
            //     secureOptions: constants.SSL_OP_NO_TLSv1_2,
            //     ciphers: 'ECDHE-RSA-AES256-SHA:AES256-SHA:RC4-SHA:RC4:HIGH:!MD5:!aNULL:!EDH:!AESGCM',
            //     honorCipherOrder: true
            // },
            // will replace content-types used to match responses in JSON and XML parsers 
            // mimetypes: {
            //     json: ["application/json", "application/json;charset=utf-8"],
            //     xml: ["application/xml", "application/xml;charset=utf-8"]
            // },
            // user: "admin", // basic http auth username if required 
            // password: "123", // basic http auth password if required 
            requestConfig: {
                timeout: 1000, //request timeout in milliseconds 
                noDelay: true, //Enable/disable the Nagle algorithm 
                keepAlive: true, //Enable/disable keep-alive functionalityidle socket. 
                keepAliveDelay: 1000 //and optionally set the initial delay before the first keepalive probe is sent 
            },
            responseConfig: {
                timeout: 1000 //response timeout 
            }
        };

        if(pathArguments){
            options.path = pathArguments;        
        }
        
        

        restClient = new RESTClient();

        if(this.method.toUpperCase()=='GET'){   
            util.debugCall('Component: %o going to invoke GET call: %s with options: %o', self, self.URL, options);   
            restClient.get(self.URL, options, function (responseBody, response){
                var status = self._retrieveResponseStatus(response);
                util.debugCall('Component: %o requesting %s received response %o with body %o', self, self.URL, status, responseBody);                         
                message.payload = responseBody;
                util.debugComponent('Component: %o requesting %s received GET response: %o', self, self.URL, status);      
                self.next(message);
            }).on('error', function (err) {
                var errorInfo = {
                    component: self,
                    message: message,
                    cause: err
                };
                self.callback(errorInfo);
            });
        }else{
            options.data = message.payload;
            util.debugCall('Component: %o going to invoke POST call: %s with options: %o', self, self.URL, options);           
            restClient.post(this.URL, options, function (responseBody, response){
                var status = self._retrieveResponseStatus(response);
                util.debugCall('Component: %o requesting %s received response %o with body %o', self, self.URL, status, responseBody);                      
                message.payload = responseBody;
                util.debugComponent('Component: %o requesting %s received POST response: %o', self, self.URL, status);          
                self.next(message);
            }).on('error', function (err) {
                var errorInfo = {
                    component: self,
                    message: message,
                    cause: err
                };
                self.callback(errorInfo);
            });
        }
    },callback);    
}

ESBCallComponent.prototype = new ESBComponent(function(){});
ESBCallComponent.prototype.constructor = ESBCallComponent;

ESBCallComponent.prototype._retrieveResponseStatus = function (restClientResponse) {
    var httpStatus = {
        message: restClientResponse.connection._httpMessage.res.statusMessage,
        code: restClientResponse.connection._httpMessage.res.statusCode
    }

    return httpStatus;
};

function createCallComponent(callback, host, URI, method, pathArguments)
{
    
    //var component = new ESBComponent(function(){});
    var component = new ESBCallComponent(callback, host, URI, method, pathArguments);       
    return component;
}

//--------- ESB Result Component
/**
 * Represents a ResultComponent that end processing message and invokes callback function with resulting message.
 * 
 * @type {function}
 */
var ESBResultComponent = function(callback){    
    ESBComponent.call(this,function(context,message){
        this.callback(null, message);
    },callback);
}

ESBResultComponent.prototype = new ESBComponent(function(){});
ESBResultComponent.prototype.constructor = ESBResultComponent;


function createResultComponent(callback)
{
    
    //var component = new ESBComponent(function(){});
    var component = new ESBResultComponent(callback);       
    return component;
}


module.exports = {    
     createLoggerComponent: createLoggerComponent,
     createMapperComponent: createMapperComponent,
     createSleepComponent: createSleepComponent,
     createVarComponent: createVarComponent,
     createCombineComponent: createCombineComponent,
     createCallComponent: createCallComponent,
     createResultComponent: createResultComponent,
     createMessage: createMessage
}