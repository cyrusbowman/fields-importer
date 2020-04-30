import React from 'react';
//import oadaid from '@oada/oada-id-client';
import devcert from './dev-cert/signed_software_statement.js';
import udevcert from './dev-cert/unsigned_software_statement.js';
import { Helmet } from 'react-helmet';
import pkg from '../package.json';

import './App.css';

import Promise from 'bluebird';
import { v4 as uuidv4 } from 'uuid';
import _ from 'lodash';
import oada from '@oada/oada-cache';
import Dropzone from 'react-dropzone';
import togeojson from '@mapbox/togeojson';
import tree from './tree';

//const getAccessTokenAsync = Promise.promisify(oadaid.getAccessToken);

let con = false;

function capitalizeFirstLetter(string) {
  return string.charAt(0).toUpperCase() + string.slice(1);
}

class App extends React.Component {

  constructor(props) {
    super(props);

    let token = localStorage['oada.token'] || false;
    if (token === 'false' || (typeof token === 'string' && token.length < 1)) {
      token = false;
    }
    let domain = localStorage['oada.domain'] || false;
    if (domain === 'false' || (typeof domain === 'string' && domain.length < 1)) {
      domain = false;
    }
    if (domain && !domain.match(/^http/)) domain = 'https://'+domain;

    this.state = { 
      showlogin: !token, // no token, show login
      showdropzone: !!token, // have token, show dropzone
      showapproval: false,
      showcomplete: false,
      message: false,
      jobs: [],
      domain,
      token: token,
    };
  }

  async fetchAllRemoteGFF() {
    this.setState({ message: 'Fetching your current fields...'});
    const root = await con.get({path: '/bookmarks/fields'}).then(r => r.data);
    const { growers, farms, fields } = await Promise.props({
      growers: Promise.reduce(_.keys(root.growers), async (acc,g) => { 
                 acc[g] = await con.get({ path: `/bookmarks/fields/growers/${g}` }).then(r=>r.data); 
                 return acc;
               }, {}, { concurrency: 5 } ),
        farms: Promise.reduce(_.keys(root.farms),   async (acc,f) => { 
                 acc[f] = await con.get({ path: `/bookmarks/fields/farms/${f}` }).then(r=>r.data); 
                 return acc 
               }, {}, { concurrency: 5 } ),
       fields: Promise.reduce(_.keys(root.fields),  async (acc,f) => { 
                 acc[f] = await con.get({ path: `/bookmarks/fields/fields/${f}` }).then(r=>r.data); 
                 return acc 
               }, {}, { concurrency: 5 } ),
    });
    return { growers, farms, fields };
  }


  // Expects a feature array (i.e. geojson.features is an array), and expects
  // each item to have propterties with Grower - Name, Farm - Name, Field - Name
  // from SST export
  geoJSONToOADA({geojson, remote}) {
    const { growers, farms, fields } = _.reduce(geojson.features, (acc,f) => {
      // Extract names from the KML:
      const grower = { name: f.properties['Grower - Name'] };
      const farm = { name: f.properties['Farm - Name'] };
      const field = { name: f.properties['Field - Name'], boundary: f.geometry };
  
      // Figure out if we've seen this grower or farm before locally:
      const gkey = _.find(_.keys(acc.growers), k => acc.growers[k].name === grower.name)
      if (gkey) grower.id = gkey;
      const fkey = _.find(_.keys(acc.farms), k => acc.farms[k].name === farm.name);
      if (fkey) farm.id = fkey;
  
      // Figure out if we already have this grower, farm, or field on the remote:
      const rgkey = _.find(_.keys(remote.growers), k => remote.growers[k].name === grower.name)
      if (rgkey) {
        // Store both the key under growers (as id) and the resourceid (as _id)
        grower.id = rgkey;
        grower._id = remote.growers[rgkey]._id;
      }
      let rfkey = _.find(_.keys(remote.farms), k => remote.farms[k].name === farm.name)
      if (rfkey) {
        farm.id = rfkey;
        farm._id = remote.farms[rfkey]._id;
      }
      rfkey = _.find(_.keys(remote.fields), k => remote.fields[k].name === field.name)
      if (rfkey) {
        field.id = rfkey;
        field._id = remote.fields[rfkey]._id;
      }
  
      // Assign new id's where we don't know them
      if (!grower.id) grower.id = uuidv4();
      if (!farm.id) farm.id = uuidv4();
      if (!field.id) field.id = uuidv4();
  
      // Assign the proper links within farm and field to their parent.
      // If the grower or farm does not have an _id, then it is not in the
      // remote and will have to be created. The eventually created link will be at resources/<id>
      // i.e. we will re-use the UUID keys as their resourceid
      farm.grower = { _id: grower._id || `resources/${grower.id}` };
      field.farm = { _id: farm._id || `resources/${farm.id}` };
  
      // Store grower, farm, field, in accumulator
      acc.growers[grower.id] = grower;
      acc.farms[farm.id] = farm;
      acc.fields[field.id] = field;
      return acc;
    }, { growers: {}, farms: {}, fields: {} });

    // At this point, anything under growers, farms, or fields that has an _id is 
    // already on the remote server, and anything without an _id is not
    return { growers, farms, fields };
  }

  // expects local.growers, local.farms, local.fields
  async constructJobList(local) {
    // Build a nice array of everything to be done so we can
    // manage concurrency.  i.e. find all the things without
    // an _id key.
    return _.reduce(['growers', 'farms', 'fields'], (acc,lt) => {
      _.each(local[lt], l => {
        if (!l._id) {
          acc.push({ type: lt.replace(/s$/,''), listtype: lt, data: l });
        }
      });
      return acc;
    }, []);
  }

  async putAllJobsToOADA(jobs) {
    console.log('Have '+jobs.length+' jobs to do, creating all the resources');
    this.setState({ message: 'Creating '+jobs.length+' resources in OADA' });

    const log = [];
    await Promise.map(jobs, async j => {
      const data = _.cloneDeep(j.data);
      const path = `/resources/${data.id}`;
      if (data.id) delete data.id; // not included in remote
      if (data._id) delete data._id; // not included in remote
      console.log('Creating resource, job = ', j);
      await con.put({ path, data, headers: { 'content-type': `application/vnd.oada.${j.type === 'growers' ? 'fields' : j.type}.1+json` } });
      log.push({ resource: path, action: 'create', type: j.type, data });
    }, { concurrency: 5 });
 
    this.setState({ message: 'Linking to new resources' });
    console.log('Created all the resources, now putting links to each of the master lists');
    await Promise.map(['growers', 'farms', 'fields'], async lt => {
      const jobsthistype = _.filter(jobs, j => j.listtype === lt);
      if (jobsthistype && jobsthistype.length < 1) {
        console.log('No '+lt+' added, not updating master lst');
        return;
      }
      const data = _.reduce(jobsthistype, (acc,j) => {
        acc[j.data.id] = { _id: `resources/${j.data.id}`, _rev: 0 };
        return acc;
      }, {});
      const path = `/bookmarks/fields/${lt}`;
      await con.put({ path, data, headers: { 'content-type': `application/vnd.oada.${lt === 'growers' ? 'fields' : lt}.1+json` } });
      log.push({ resource: `/bookmarks/fields/${lt}`, action: 'put', type: lt, data });
    });
  
    this.setState({ showcomplete: true });
    console.log('Posted all links to each list type');
    return log;
  }

  async droppedFiles(files) {
    this.setState({ message: 'Connecting to OADA...' });
    this.setState({ showdropzone: false });
    // Connect using a token from localstorage (should be handled by the cache itself already)
    con = await oada.connect({
      token: this.state.token, 
      domain: this.state.domain, 
      cache: false
    });
  
    files.forEach(async f => {
      console.log('Ensuring growers, farms, fields base paths exist on remote');
      await Promise.map(['grower', 'farms', 'fields'], lt => 
        con.put({ path: `/bookmarks/fields/${lt}`, tree, data: {}, headers: { 'content-type': `application/vnd.oada.${lt}.1+json` } })
      );
  
      const { geojson, remote } = await Promise.props({
        // Read and convert local file to geojson
        geojson: new Promise((resolve,reject) => {
          console.log('Reading local KML file and converting to goejson');
          const reader = new FileReader()
          reader.onabort = () => { console.log('file reading was aborted'); reject(); }
          reader.onerror = () => { console.log('file reading has failed');  reject(); }
          reader.onload = async () => {
            const binaryStr = reader.result;
            const domparser = new DOMParser();
            const kml = domparser.parseFromString(binaryStr, 'text/xml');
            const geojson = togeojson.kml(kml);
            console.log('kml = ', kml, ', geojson = ', geojson);
            console.log('Extracting growers, farms, fields locally...');
            resolve(geojson);
          }
          reader.readAsText(f);
        }),
  
        // Fetch current state of all remote resources to match up names/id's
        remote: this.fetchAllRemoteGFF(),
      });
 
      this.setState({ message: 'Comparing KML with what you have to decide if anything is new' });
      console.log('Harmonizing local GFF with remote GFF, remote = ', remote);
      const local = this.geoJSONToOADA({geojson, remote});
  
      console.log('Preparing to update remote, Final local gff = ', local);
      const jobs = await this.constructJobList(local);
      this.setState({
        jobs, showapproval: true, message: false,
      });
      
      console.log('Done!');
    })

  }

  async doLogin() {
    let domain = this.state.domain;
    if (typeof domain === 'string' && !domain.match(/^http/)) {
      domain = 'https://'+domain;
    }
    localStorage['oada.domain'] = domain;
    const redirect = (process.env.NODE_ENV === 'production' ? udevcert.redirect_uris[2] : udevcert.redirect_uris[1]); // 2 is openatk.com, 1 is http://localhost:3000
    console.log('redirect = ', redirect);

    // Get new token
    con = await oada.connect({
      domain: this.state.domain, 
      cache: false,
      options: {
        redirect: "http://localhost:3000/fields-importer/oauth2/redirect.html",
        metadata:"eyJ0eXAiOiJKV1QiLCJhbGciOiJSUzI1NiIsImtpZCI6InluMjJ1akJVQ0VlbE5VUnJhOW9na2hlRDJLRVhvbGprc21BVnFGcTBMUGciLCJqd2siOnsia3R5IjoiUlNBIiwia2lkIjoieW4yMnVqQlVDRWVsTlVScmE5b2draGVEMktFWG9samtzbUFWcUZxMExQZyIsIm4iOiJycjM4aUs4RmkwXy1DUkxUdlZLNElJQ2xhcmlpNndWSHBFN3paUFhvRVJsX09vaDY0WW1iUWNSYTVlRncwVVFoVXZFQ2hLdTlObzNqbTdMVzlaY0wxSEtyaGtVVy1PUW9iT1hVbnJDZ29DcGE4VlloX3dSSWRRWWJzdlBRVmo1Tkd1dU5YYVpCX19weEZ5LW5fTzJJTVM4T0dyZXptM2JRSERBZi1qbmdJaFpHWmdMYXZMSnlTSFV5RFFMNEZiUTZEM1F6M0FNT3J4RnZhNEtCSVBDUUtGT21ZWFZuNHp0Z1Q2OGhneU1vYzFLeXR4b1JnelZIbkNkVHBQV1dWcm5NRmNKZWRZRC1MbWswWG81cmpZT3htcThBMWVqZnhQTWVSXzNWNzhBSmsyTERJNHZHYUozZm5hUFpTN0N2VzhGM3BXV2lqX0J5VkdDSS01QnJrcUhfblEiLCJlIjoiQVFBQiJ9fQ.eyJyZWRpcmVjdF91cmlzIjpbImh0dHBzOi8vbG9jYWxob3N0OjMwMDAvZmllbGRzLWltcG9ydGVyL29hdXRoMi9yZWRpcmVjdC5odG1sIiwiaHR0cDovL2xvY2FsaG9zdDozMDAwL2ZpZWxkcy1pbXBvcnRlci9vYXV0aDIvcmVkaXJlY3QuaHRtbCIsImh0dHBzOi8vb3BlbmF0ay5jb20vZmllbGRzLWltcG9ydGVyL29hdXRoMi9yZWRpcmVjdC5odG1sIiwiaHR0cHM6Ly9vcGVuYXRrLmdpdGh1Yi5pby9maWVsZHMtaW1wb3J0ZXIvb2F1dGgyL3JlZGlyZWN0Lmh0bWwiXSwidG9rZW5fZW5kcG9pbnRfYXV0aF9tZXRob2QiOiJ1cm46aWV0ZjpwYXJhbXM6b2F1dGg6Y2xpZW50LWFzc2VydGlvbi10eXBlOmp3dC1iZWFyZXIiLCJncmFudF90eXBlcyI6WyJhdXRob3JpemF0aW9uX2NvZGUiXSwicmVzcG9uc2VfdHlwZXMiOlsidG9rZW4iLCJjb2RlIiwiaWRfdG9rZW4iLCJpZF90b2tlbiB0b2tlbiIsImNvZGUgaWRfdG9rZW4iLCJjb2RlIHRva2VuIiwiY29kZSBpZF90b2tlbiB0b2tlbiJdLCJjbGllbnRfbmFtZSI6Ik9wZW5BVEsgRmllbGRzIEltcG9ydGVyIiwiY2xpZW50X3VyaSI6Imh0dHBzOi8vb3BlbmF0ay5jb20vZmllbGRzLWltcG9ydGVyIiwiY29udGFjdHMiOlsiQWFyb24gQXVsdCA8YXVsdGFjQHB1cmR1ZS5lZHU-Il0sImp3a3MiOnsia2V5cyI6W3sia3R5IjoiUlNBIiwia2lkIjoiZjdmODBkMGRkZTk5NGRjMGFlNzBlYWU1M2E1MzMxYjIiLCJlIjoiQVFBQiIsIm4iOiJ4eTV5YWRKZnpiS1FuYVJGcnJBbmVwWU56Z0VRemtXTE4yRUtSQThFSkplN2F5elFVMWxzOXgwckIxa0YxYWlkUGVSY3E3YVVMLVNIYjNFdlFyRHhaR1BDWElYYzVXWlBEUTRabmduR2JHdU90bHFHV2tIVFZIc1pRYTZjSkZ2U21qN3hCWHVCd1hNMFJ0SFNaSWN5V0ptY0xPWW15Umt4ay1QSFpCYXlMTzgzZ1RnMlBxZmMxVEdpRmN5bUotQk4wTWpjT2NlQ0MyRzB2aEhfWHI0dlktOTQzeHI2eS1meTdvMFQ2S1Y2dm1IaW45Y1R4clRja2U3Y2cwZ2tzNmZtYzhiLWdkdFFpWjBYOHEyMmN3YXJXZFVLV1pOekxSRmpNMzhXb0x3NFFhVlhZaFBJbTc2N3NyVlhGQ1F0MlQ5bnNuTy1UMXYzUUNqTzc4S2pPVFFjSHcifV19fQ.qfFVmPOfVTvvBUzc9Ib7ZUFwsnKeT7XF7t6gr0CiPVR89jyeWDmKcbFAQskR7UeBCD3gNKma3AGvUpZrtlSSy4WYdavES7e5lp5YINB3xPD4FcafLJRLVV7tTLrbRZbDD1-Kg43sjl5mR4Ze-gEdA5ODId4NRWaibeFLJ_lzc7neWNZh4UbqupvautaytbzV_2Z-xs1wLirObm_LsQCBkknyfpwMbDUynxQMB4Qg9bMvN3KFC1LIFPng2xLfP7pPIU8SmmBkLTWX7Wx2vN5GtCM2p1ut0E8Zvq7IeWJ2QZvvy7Ouy_5e6TXux9QD_mrfpe8XhifD71xowkJast24GA",
        scope: "oada.yield:all",
      },
    })

/*
    const token = await getAccessTokenAsync(domain.replace(/^https:\/\//,''), { 
      metadata: devcert, 
      scope: 'oada.fields:all',
      redirect
    }).then(r=>r.access_token);
    */
    console.log(con);
    let token = con.token;
    localStorage['oada.token'] = token;
    this.setState({
      token,
      showlogin: false,
      showdropzone: true,
    });
  }

  doLogout() {
    localStorage['oada.token'] = false;
    this.setState({ showlogin: true, showdropzone: false, showcomplete: false, showapproval: false, token: false });
  }

  domainChanged(evt) {
    let domain = evt.target.value;
    this.setState({ domain });
  }

  render() {
    const jobs = this.state.jobs || [];
    const approvals = {
      growers: _.filter(jobs, j => j.type === 'grower'),
      farms: _.filter(jobs, j => j.type === 'farm'),
      fields: _.filter(jobs, j => j.type === 'field'),
    };
    
    return (
      <div className="App" style={{ fontFamily: 'arial' }}>
        <Helmet>
          <title>OpenATK Fields Importer - v{pkg.version}</title>
        </Helmet>
        <div style={{ backgroundColor: '#0066CC', color: '#FFFFFF', fontSize: '2em', padding: '5px', textAlign: 'left', display: 'flex', flexDirection: 'row', alignItems: 'center' }}>
          <div>OpenAgToolkit Fields Importer</div>
          <div style={{flexGrow: 1}}></div>
          {this.state.showlogin ? '' : 
            <div onClick={() => this.doLogout()} style={{ fontSize: '0.7em', color: '#FFFFFF', textDecoration: 'underline' }}>
              {this.state.token ? 'Logout' : 'Login'}
            </div>
          }
        </div>


        {this.state.message ? <div style={{color: '#00AA00', padding: '5px', margin: '5px' }}>{this.state.message}</div> : null }

        {!this.state.showlogin ? '' : 
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
            <div style={{ fontSize: '2em', padding: '20px' }}>Where should I sync fields to?</div>
            <div style={{  }}><input style={{fontSize: '1.0em', width: '250px'}} type="text" value={this.state.domain || ''} onChange={evt => this.domainChanged(evt)} /></div>
            <div style={{ margin : '10px', borderRadius: '3px', border: '1px solid #CCCCCC', width: '250px', backgroundColor: '#3399FF', color: '#FFFFFF', fontSize: '2em', cursor: 'pointer'  }} onClick={() => this.doLogin()}>Connect</div>
          </div>
        }

        {! this.state.showdropzone ? '' : 
          <div>
            <p>Drop a KML from Ag Leader SMS here and it will ensure those growers, farms, and fields exist at your OADA cloud.</p>
            <Dropzone onDrop={f => this.droppedFiles(f)}>
              {({getRootProps, getInputProps}) => (
                <section>
                  <div style={{
                       flex: 1, display: 'flex', 
                       justifyContent: 'center',
                       alignItems: 'center',
                       border: '3px dashed #BBBBBB', 
                       borderRadius: '10px',
                       margin: '5px',
                       padding: '5px',
                       minHeight: '50vh',
                    }} {...getRootProps()}>
                    <input {...getInputProps()} />
                    <p key='thep'>Drop KML files with your fields here.</p>
                  </div>
                </section>
              )}
            </Dropzone>
          </div>
        }

        {!this.state.showapproval ? null : 
          <div>
            { approvals.growers.length < 1 && approvals.farms.length < 1 && approvals.fields.length < 1
              ? <div style={{color: '#00BB00', padding: '5px', margin: '5px'}}>
                  Your remote OADA cloud is up to date with the names in this KML file, nothing new to send!
                </div>
              : <div style={{ padding: '10px' }}>
                  <div style={{ fontSize: '2em' }}>About to add the following items to your remote OADA cloud</div>
                  <div onClick={() => {
                      this.setState({ showapproval: false });
                      this.putAllJobsToOADA(this.state.jobs);
                    }} style={{ backgroundColor: '#3399FF', borderRadius: '3px', color: '#FFFFFF', fontSize: '1.5em', margin: '15px' }}>
                    Click to Approve
                  </div>
                </div>
            }
            {_.map(['growers', 'farms', 'fields'], t => {
              console.log("WTF APPROVALS", t, approvals[t])
              if (approvals[t].length < 1) return null;
              return (
                <div key={t+'-list'}>
                  <div style={{ textAlign: 'left', padding: '5px', fontWeight: 'bold', fontSize: '1.5em' }}>{capitalizeFirstLetter(t)} ({approvals[t].length} new):</div>
                  <div style={{ display: 'flex', flexWrap: 'wrap', flexDirection: 'row' }}>
                    {_.map(approvals[t], (f,i) => 
                      <div key={'approval'+t+i} style={{ padding: '5px', margin: '5px', borderRadius: '2px', border: '1px solid #EEEEEE' }}>
                        {f.data.name}
                      </div>)
                    }
                  </div>
                </div>
              );
            })}
          </div>
        }

        {!this.state.showcomplete ? null : 
          <div style={{color: 'green' }}>
            Complete!
          </div>
        }

        <div className='footer-bar' style={{ display: 'flex', flexDirection: 'row', justifyContent: 'space-around', alignItems: 'center', flexWrap: 'wrap', position: 'absolute', bottom: '0px', width: '99vw' }}>
          <div className='footer-bar-element'>
            <b>License:</b><br/>Apache 2.0
          </div>
          <div className='footer-bar-element'>
            <a href="http://trellisframework.org">
              <img className='footer-logo' width='200px' src='/fields-importer/logo-trellis.png'/>
            </a>
          </div>
          <div className='footer-bar-element'>
            <a href="http://oatscenter.org">
              <img className='footer-logo' width='200px' src='/fields-importer/logo-oats.png'/>
            </a>
          </div>
          <div className='footer-bar-element'>
            <a href="http://oatscenter.org">
              <img className='footer-logo' width='200px' src='/fields-importer/logo-purdue.png'/>
            </a>
          </div>
          <div className='footer-bar-element'>
            Many thanks to key sponsor <br/><a href='https://winfieldunited.com'>Winfield United</a>!
          </div>
        </div>

      </div>
    );
  }
}

export default App;
