Serverless Plugin KMSVariables
==========================

This Plugin adds KMS Support to the Variables of Serverless.

*Note*: This plugin supports Serverless 0.5.* 


### Installation

 - make sure that aws and serverless are installed
 - see http://docs.aws.amazon.com/cli/latest/userguide/installing.html
 - see http://www.serverless.com/
 - 
 - Create a KMS key in your AWS Account
 - see http://docs.aws.amazon.com/kms/latest/developerguide/create-keys.html
 - 
 - install this plugin to your project
 - (adds the plugin to your node_modules folder)

```
cd projectfolder
npm install serverless-plugin-kmsvariables
```

 - add the plugin to your s-project.json file
 - add configuration for KMS to your s-project file

```
"custom": {
    "kmsVariables": {
      "key_arn": "arn:aws:kms:<region>:<accountid>:key/<keyid>"
    }
},
"plugins": [
    "serverless-plugin-kmsvariables"
]
```

### Run the Plugin

 - the plugin uses a hook that is called in turn of the underlying Serverless VariableSet/VariableList actions. 
 - the plugin uses a hook that is called before functionRun and functionDeploy calls, where the variables are decrypted using KMS.

### Example usage
#### Set a normal variable
```
serverless variables set -s <stage> -r <region> -t <type> -k <key> -v <value>
```
Output:
```
$ serverless variables set -s dev -r us-east-1 -t region -k plaintextVariable -v foo
Serverless: Not encrypting variable  
Serverless: Successfully set variable: plaintextVariable 
```
#### Set an encrypted variable
Command:
```
serverless variables set -s <stage> -r <region> -t <type> -k <key> -v <value> -e
```
Ouput:
```
$ serverless variables set -s dev -r us-east-1 -t region -k myPassword -v mySuperSecret -e
Serverless: Calling AWS KMS to encrypt variable  
Serverless: Successfully set variable: myPassword  
```

#### List variables (without decryption)
```
serverless variables list -s <stage> -r <region>
```
Output:
```
Serverless: common:  
Serverless: project = ceng-lambda-nsox  
Serverless:     dev:  
Serverless:     stage = dev  
Serverless:     foo-stage = bar1  
Serverless:         us-east-1:  
Serverless:         region = us-east-1  
Serverless:         resourcesStackName = example  
Serverless:         iamRoleArnLambda = arn:aws:iam::<accountid>:role/<rolename> 
Serverless:         plaintextVariable = foo
Serverless:         myPassword = *******
```
#### List variables (with decryption)
```
serverless variables list -s <stage> -r <region> -d
```
Output:
```
Serverless: common:  
Serverless: project = ceng-lambda-nsox  
Serverless:     dev:  
Serverless:     stage = dev  
Serverless:     foo-stage = bar1  
Serverless:         us-east-1:  
Serverless:         region = us-east-1  
Serverless:         resourcesStackName = example  
Serverless:         iamRoleArnLambda = arn:aws:iam::<accountid>:role/<rolename>
Serverless:         plaintextVariable = foo
Serverless:         myPassword = mySuperSecret
```

