'use strict';

/**
 * Action: VariablesList, VariablesSet
 * - List all variables defined in your project (Decrypted with KMS).
 * - Set variable in your project (Optional: Encrypted with KMS).
 */

module.exports = function(S) {

  const BbPromise  = require('bluebird'),
    AWS        = require('aws-sdk'),
    chalk      = require('chalk'),
    _          = require('lodash'),
    SError     = require(S.getServerlessPath('Error')),
    SCli       = require(S.getServerlessPath('utils/cli'));

  class VariablesKMS extends S.classes.Plugin {

    static getName() {
      return this.name;
    }

    /**
     * @returns {Promise} upon completion of all registrations
     */
    registerActions() {
      S.addAction(this.variablesSet.bind(this), {
        handler:       'variablesSet',
        description:   'Defines a new variable that can be used in any of your project\'s configuration files. Usage: serverless variables set',
        context:       'variables',
        contextAction: 'set',
        options:       [
          {
            option:      'type',
            shortcut:    't',
            description: 'variable type (common, stage or region)'
          },
          {
            option:      'region',
            shortcut:    'r',
            description: 'region you want to set the variable in'
          },
          {
            option:      'stage',
            shortcut:    's',
            description: 'stage you want to set the variable in'
          },
          {
            option:      'key',
            shortcut:    'k',
            description: 'the key of the variable you want to set'
          },
          {
            option:      'value',
            shortcut:    'v',
            description: 'the value of the variable you want to set'
          },
          {
            option:      'encrypt',
            shortcut:    'e',
            description: 'should value be encrypted'
          }
        ]
      });
      S.addAction(this.variablesList.bind(this), {
        handler:       'variablesList',
        description:   'List all variables defined in your project. Usage: serverless variables list',
        context:       'variables',
        contextAction: 'list',
        options:       [
          {
            option:      'region',
            shortcut:    'r',
            description: 'region you want to list variables from'
          },
          {
            option:      'stage',
            shortcut:    's',
            description: 'stage you want to list variables from'
          },
          {
            option:      'all',
            shortcut:    'a',
            description: 'list all available variables'
          },
          {
            option:      'decrypt',
            shortcut:    'd',
            description: 'decrypt encrypted variables'
          }
        ]
      });
      return BbPromise.resolve();
    }

    /**
     * @returns {Promise} upon completion of all registrations
     */
    registerHooks() {
        S.addHook(this._variableReplace.bind(this), {
            action: 'functionDeploy',
            event:  'pre'
        });
        S.addHook(this._variableReplace.bind(this), {
            action: 'functionRun',
            event:  'pre'
        });
        return BbPromise.resolve();
    }

    /**
     * Decrypt Variables as they are
     * packaged into the runtime/build
     */
    _variableReplace(evt) {
      let _this = this;

      // Promise to decrypt, here for scoping
      const scopedDecrypt = function(regionOrStage, variable, value) {
        return _this._decrypt(value, true).then(decrypted => [regionOrStage, variable, decrypted]);
      };

        return new BbPromise(function(resolve, reject) {
          let listRegionVariableHelper = (region) => {
            let promises = [];
            let variables = region.getVariables();
            for (var variable in variables) {
              if (!_.startsWith(variable, '_') && _.has(variables, variable)) {
                if(typeof variables[variable] === 'object') {
                  if('value' in variables[variable]) {
                    if('encrypted' in variables[variable] && variables[variable].encrypted === 'true') {
                      promises.push(scopedDecrypt(region, variable, variables[variable].value));
                    } else {
                      region.variables[variable] = variables[variable].value;
                    }
                  }
                }
              }
            }
            return promises;
          };

          let listStageVariableHelper = (stage) => {
            let promises = [];
            let variables = stage.getVariables();
            for (var variable in variables) {
              if (!_.startsWith(variable, '_') && _.has(variables, variable)) {
                if(typeof variables[variable] === 'object') {
                  if('value' in variables[variable]) {
                    if('encrypted' in variables[variable] && variables[variable].encrypted === 'true') {
                      promises.push(scopedDecrypt(stage, variable, variables[variable].value));
                    } else {
                      stage.variables[variable] = variables[variable].value;
                    }
                  }
                }
              }
            }
            return promises;
          };

          let promises = [];
          if (!evt.options.runDeployed) {
            if(evt.options.stage) {
              let stage = S.getProject().getStage(evt.options.stage);
              promises = promises.concat(listStageVariableHelper(stage));
              if(evt.options.region) {
                let region = stage.getRegion(evt.options.region);
                promises = promises.concat(listRegionVariableHelper(region));
              } else {
                S.getProject().getAllRegions(stage.getName()).forEach(function (region) {
                    promises = promises.concat(listRegionVariableHelper(region));
                });
              }
            } else {
              S.getProject().getAllStages().forEach(stage => {
                promises = promises.concat(listStageVariableHelper(stage));
                S.getProject().getAllRegions(stage.getName()).forEach(function (region) {
                  promises = promises.concat(listRegionVariableHelper(region));
                });
              });
            }
          }
          BbPromise.mapSeries(promises, function(val) {
            // StageOrRegion, key, value = val
            val[0].variables[val[1]] = val[2];
          }).then(function() {
            resolve(evt);
          });
      });
    }

    /**
     * Turn key, value into string.
     * Decrypt values as needed.
     */
    _variableSetToString(key, value, spacing) {
      let _this = this;
      return new BbPromise(function(resolve) {
        let decrypt = false;
        if(typeof value === 'object') {
          if(!_this.evt.options.decrypt){
            value = '*******';
          } else if('value' in value) {
            if('encrypted' in value && value.encrypted === 'true') {
              decrypt = true;
              value = value.value;
            }
          }
        }
        _this._decrypt(value, decrypt).then(function(val) { resolve(chalk.green(spacing + chalk.bold(key) + ' = ' + val));});
      });
    }

    /**
     * Encrypt value if needed
     */
    _encrypt(value, encrypt) {
      let _this = this;
      return new BbPromise(function(resolve, reject) {
        if(!encrypt) {
          SCli.log('Not encrypting variable');
          resolve(value);
        } else {
          SCli.log('Calling AWS KMS to encrypt variable');
          let key_arn = _this._getKMSID();
          let key_region = key_arn.split(':')[3];
          let params = {region: key_region};

          let kms = new AWS.KMS(params);
          params = {KeyId: key_arn, Plaintext: value};
          kms.encrypt(params, function(err, data) {
            value = '';
            if(err) {
              reject(err);
            } else {
              if('CiphertextBlob' in data) {
                resolve({ 'encrypted': 'true', 'value': data.CiphertextBlob.toString('base64')});
              } else {
                reject('Encrypted value missing in result from AWS')
              }
            }
          });
        }
      });
    }

    /**
     * Decrypt value if needed
     */
    _decrypt(value, decrypt) {
      let _this = this;
      return new BbPromise(function(resolve, reject) {
        if(!decrypt) {
          resolve(value);
        } else {
          let key_arn = _this._getKMSID();
          let key_region = key_arn.split(':')[3];
          let params = {region: key_region};
          let kms = new AWS.KMS(params);
          params = {CiphertextBlob: new Buffer(value, 'base64')};
          kms.decrypt(params, function(err, data) {
            if (err) {
              console.log(err, err.stack);
              reject(err);
            } else {
              resolve(data.Plaintext.toString('ascii'));
            }
          });
        }
      });
    }

    /**
     * Get the KMS Key ARN from project
     */
    _getKMSID() {
      let Project = S.getProject();
      if('custom' in Project && 'kmsVariables' in Project.custom && 'key_arn' in Project.custom.kmsVariables) {
        return Project.custom.kmsVariables.key_arn
      }
      return;
    }

    /**
     * Action
     */
    variablesSet(evt) {

      let _this    = this;
      _this.evt    = evt;

      return _this._promptSet()
          .bind(_this)
          .then(_this._validateAndPrepareSet)
          .then(_this._setVariable)
          .then(function() {
            SCli.log('Successfully set variable: ' + _this.evt.options.key);
            return _this.evt;
          });
    }

    /**
     * Prompt key, value, stage and region
     */
    _promptSet() {
      let _this = this;

      if (!S.config.interactive) return BbPromise.resolve();

      return BbPromise.try(function() {

            // Skip if key is provided already
            if (_this.evt.options.key) return;

            let prompts = {
              properties: {}
            };

            prompts.properties.key = {
              description: 'Enter variable key to set a value to: '.yellow,
              required:    true
            };

            return _this.cliPromptInput(prompts, { key: _this.evt.options.key })
                .then(function(answers) {
                  _this.evt.options.key = answers.key;
                });
          })
          .then(function() {

            // Skip if value is provided already
            if (_this.evt.options.value) return;

            let prompts = {
              properties: {}
            };

            prompts.properties.value = {
              description: 'Enter variable value to set a value to: '.yellow,
              required:    true
            };

            return _this.cliPromptInput(prompts, { value: _this.evt.options.value })
                .then(function(answers) {
                  _this.evt.options.value = answers.value;
                });
          })
          .then(function() {
            // Allow to dismiss region to set stage variables
            const selection = [
                             {key:"1) ", value:"common", label:"Common"},
                             {key:"2) ", value:"stage", label:"Stage"},
                             {key:"3) ", value:"region", label:"Region"}
                            ];
            if (_.indexOf(['common','stage','region'], _this.evt.options.type) !== -1) {
              return BbPromise.resolve();
            }
            return _this.cliPromptSelect('Select variable type: ', selection, false)
            .spread(function(selectType) {
              _this.evt.options.type = selectType.value;
              return BbPromise.resolve();
            });
          })
          .then(function() {
            if (_this.evt.options.type === 'common') {
              return BbPromise.resolve();
            }
            return _this.cliPromptSelectStage('Select a stage to set your variable in: ', _this.evt.options.stage, false)
                .then(stage => {
                  _this.evt.options.stage = stage;
                })
          })
          .then(function() {
            if (_this.evt.options.type !== "region") {
              return BbPromise.resolve();
            }
            return _this.cliPromptSelectRegion('Select a region to set variable in: ', false, true, _this.evt.options.region, _this.evt.options.stage)
                .then(region => {
                  _this.evt.options.region = region;
                });
          });
    }

    /**
     * Validate all data from event, interactive CLI or non interactive CLI
     * and prepare data
     */
    _validateAndPrepareSet() {
      let _this = this;

      // non interactive validation
      if (!S.config.interactive) {
        // Check Params
        const paramsOk = (!!_this.evt.options.type && !!_this.evt.options.key && !!_this.evt.options.value) &&
                         (_this.evt.options.type === 'common' ||
                           (_this.evt.options.type === 'stage' && !!_this.evt.options.stage) ||
                           (_this.evt.options.type === 'region' && !!_this.evt.options.stage && !!_this.evt.options.region));

        if (!paramsOk) {
          return BbPromise.reject(new SError('Wrong parameter combination or missing key/value. See --help.'));
        }
      }

      // Validate stage: make sure stage exists
      if ((_this.evt.options.type !== 'common') && !S.getProject().validateStageExists(_this.evt.options.stage) && _this.evt.options.stage != 'local') {
        return BbPromise.reject(new SError('Stage ' + _this.evt.options.stage + ' does not exist in your project'));
      }

      // Skip the next validation if stage is 'local' & region is 'all'
      if (_this.evt.options.type === 'region' && _this.evt.options.stage != 'local' && _this.evt.options.region != 'all') {

        // validate region: make sure region exists in stage
        if (!S.getProject().validateRegionExists(_this.evt.options.stage, _this.evt.options.region)) {
          return BbPromise.reject(new SError('Region "' + _this.evt.options.region + '" does not exist in stage "' + _this.evt.options.stage + '"'));
        }
      }
    }

    /**
     * Set the variable and save it
     */
    _setVariable() {
      let _this  = this,
            type  = this.evt.options.type,
            stage  = this.evt.options.stage,
            region = this.evt.options.region,
            project = S.getProject();
      return new BbPromise(function(resolve) {

        let setVariableHelper = (region) => {

          let v = {};
          v[_this.evt.options.key] = _this.evt.options.value;

          region.addVariables(v);
          region.save();
        };


        _this._encrypt(_this.evt.options.value, _this.evt.options.encrypt).then(function(value) {
          let v = {};
          v[_this.evt.options.key] = value;
          switch (type) {
            case 'common':
              project.addVariables(v);
              project.save();
              break;
            case 'stage':
              project.getStage(stage).addVariables(v);
              project.getStage(stage).save();
              break;
            case 'region':
              S.getProject().getRegion(stage, region).addVariables(v);
              S.getProject().getRegion(stage, region).save();
              break;
          }
          return resolve();
        });
      });
    }

    /**
     * Action
     */
    variablesList(evt) {

      let _this    = this;
      _this.evt    = evt;

      return _this._promptList()
          .bind(_this)
          .then(_this._validateAndPrepareList)
          .then(_this._listVariables)
          .then(function() {
            return _this.evt;
          });
    }

    /**
     * Prompt key, value, stage and region
     */
    _promptList() {
      let _this = this;
      return BbPromise.resolve();
      if (!S.config.interactive || _this.evt.options.all) return BbPromise.resolve();

      return BbPromise.try(function() {
          return _this.cliPromptSelectStage('Select a stage: ', _this.evt.options.stage, false)
                .then(stage => {
                  _this.evt.options.stage = stage;
                });
          })
          .then(function() {
            return _this.cliPromptSelectRegion('Select a region: ', false, true, _this.evt.options.region, _this.evt.options.stage)
                .then(region => {
                  _this.evt.options.region = region;
                });
          });
    }

    /**
     * Validate all data from event, interactive CLI or non interactive CLI
     * and prepare data
     */
    _validateAndPrepareList() {
      let _this = this;

      // non interactive validation
      if (!S.config.interactive) {
        // Check Params
        if (!_this.evt.options.all && (!_this.evt.options.stage || !_this.evt.options.region)) {
          return BbPromise.reject(new SError('Missing stage and/or region'));
        }
      }

      if (_this.evt.options.all) {
        _this.evt.options.region = 'all';
      } else {
        // Validate stage: make sure stage exists
        if (_this.evt.options.stage && !S.getProject().validateStageExists(_this.evt.options.stage) && _this.evt.options.stage != 'local') {
          return BbPromise.reject(new SError('Stage ' + _this.evt.options.stage + ' does not exist in your project'));
        }

        // Skip the next validation if stage is 'local' & region is 'all'
        if (_this.evt.options.region && _this.evt.options.stage != 'local' && _this.evt.options.region != 'all') {
          // validate region: make sure region exists in stage
          if (_this.evt.options.stage && !S.getProject().validateRegionExists(_this.evt.options.stage, _this.evt.options.region)) {
            return BbPromise.reject(new SError('Region "' + _this.evt.options.region + '" does not exist in stage "' + _this.evt.options.stage + '"'));
          }
        }
      }
    }

    /**
     * Set the variable and save it
     */
    _listVariables() {
      let _this  = this,
          stage  = this.evt.options.stage,
          region = this.evt.options.region,
          all    = this.evt.options.all;

      let listVariableHelper = (variables, spacing) => {
        let promises = [];
        for(var variable in variables) {
          if (!_.startsWith(variable, '_') && _.has(variables, variable)) {
            promises.push(this._variableSetToString(variable, variables[variable], spacing));
          }
        }
        return promises;
      };


      let stages = [];
      if(stage && stage != 'all') {
        stages = [S.getProject().getStage(stage)];
      } else {
        stages = S.getProject().getAllStages();
      }
      if (region && region != 'all') {
          stages = stages.filter(function(stage) {
            return typeof stage.getRegion(region) !== "undefined";
          });
      }

      if(stages.length > 0) {
        let data = [chalk.underline('common:')];
        data = data.concat(listVariableHelper(S.getProject().getVariables(),''));


        stages.forEach(stage => {
          let stageName = stage.getName();

          let stageRegions = S.getProject().getAllRegions(stageName);
          if (region && region != 'all') {
            stageRegions = stageRegions.filter(function(stageRegion) { return region == stageRegion.getName();})
          }
          data.push('    ' + chalk.underline(stageName) + ':');
          data = data.concat(listVariableHelper(stage.getVariables(), '    '));

          stageRegions.forEach(function (region) {
            data.push('        ' + chalk.underline(region.getName()) + ':');
             data = data.concat(listVariableHelper(region.getVariables(), '        '));
          });
        });

        BbPromise.mapSeries(data, function(val) { return val; }).then(
          function(val) {
            val.forEach(function(val) {
              SCli.log(val);
            });
        });
      } else {
        SCli.log('No matching stages/regions')
      }
      /*
      } else if (region != 'all' || stage == 'local') {  //single region
        if (stage == 'local') {
          region = 'local';
        }

        listStageVariableHelper(S.getProject().getStage(stage));
        listRegionVariableHelper(S.getProject().getRegion(stage, region));
      } else {
        // All regions
        listStageVariableHelper(S.getProject().getStage(stage));
        S.getProject().getAllRegions(stage).forEach(function (region) {
          listRegionVariableHelper(region);
        });
      }*/
    }

  }
  return( VariablesKMS );
};
