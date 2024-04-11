const { SlashCommandBuilder, ApplicationCommandOptionType, EmbedBuilder} = require('discord.js');
const { QueryType, useMainPlayer , useQueue} = require('discord-player');
require('dotenv').config();
const mongoose = require('mongoose');
const { givePoint } = require('../utils/givePoint');
const { getTopPlayer } = require('../utils/getTopPlayer');
const { resetScore } = require('../utils/resetScore');
const { validateLink } = require('../utils/validateSpotifyLink');
module.exports = {
    
    data: new SlashCommandBuilder()
    .setName('quiz')
    .setDescription('Starts a quiz game using a given spotify playlist link'),
    options: [
        {
            name : 'playlist-link',
            description : 'link to the spotify playlist',
            type : ApplicationCommandOptionType.String,
            required : true,
        }
    ],
    run: async ({ client, interaction }) => {
        if(!interaction.member.voice.channel){
            return interaction.reply('You must be in a voice channel to use this command.');
        }
        const link = interaction.options.get('playlist-link').value; //stores user input into link
        const startEmbed = new EmbedBuilder().setTitle('Starting game!')
        interaction.reply({embeds: [startEmbed]});
        interaction.guild.commands.set([]);
        //example playlist link : https://open.spotify.com/playlist/04ETACGQVjIH92ITiwC596?si=64ce9ea3ce834156
        //we need the part that is after playlist/ and before ? (04ETACGQVjIH92ITiwC596)
        

        //console.log( await validateLink(link));
        if(!await validateLink(link)){
            interaction.channel.send('Invalid input. Please enter a spotify playlist link.');
            return;
        }
        let playlist_id = link.split('playlist/')[1];
        playlist_id = playlist_id.split('?')[0];
        //console.log(temp);

        //gets access token from spotify api using client credential auth flow
        async function getToken() {
            const response = await fetch('https://accounts.spotify.com/api/token', {
              method: 'POST',
              body: new URLSearchParams({
                'grant_type': 'client_credentials',
              }),
              headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'Authorization': 'Basic ' + (Buffer.from(process.env.SPOTIFY_CLIENT_ID + ':' + process.env.SPOTIFY_CLIENT_SECRET).toString('base64')),
              },
            });
          
            return await response.json();
        }

        //gets playlist info from user input
        async function getPlaylistInfo(access_token) {
            const response = await fetch(`https://api.spotify.com/v1/playlists/${playlist_id}/tracks`, {
                method: 'GET',
                headers: { 'Authorization': 'Bearer ' + access_token },
            })
        
            return await response.json();
        };
        

        //function to get rest of songs if the playlist > 100 songs
        //did not know how to add the limit and offset as params/options so i hard coded into the api call
        async function getRestOfSongs(access_token, currOffset){
            const response = await fetch(`https://api.spotify.com/v1/playlists/${playlist_id}/tracks?limit=100&offset=${currOffset}`, {
                method: 'GET',
                headers: { 'Authorization': 'Bearer ' + access_token },
            })

            return await response.json();
        }

    

        
        //receives an array and shuffles the elements using Fisher Yates algorithm
        function shuffleSongs(song_array){
            for (let i = song_array.length-1; i > 0; i--){
                let random_index = Math.floor(Math.random() * (i+1));
                [song_array[i], song_array[random_index]] = [song_array[random_index], song_array[i]];
            }
            return song_array;
        }

        //if a playlist > 100 songs then next !null
        //if next ! null we need to loop get rest of songs and store them into song array
        //maybe its better to start backwards from the end of playlist so we have a definite number
        //maybe theres a way to execute all api calls at once and wait for promise all? if we need 6 iterations, we can call all 6 at once 

        //use await over then? maybe thatll allow loop

        const accessToken_obj = await getToken(); //returns json obj with access token
        const accessToken = accessToken_obj.access_token; 
        const playlist_info = await getPlaylistInfo(accessToken) 

        //console.log(accessToken.access_token);
        //console.log(playlist_info);

        let array_songs = [];

        const total_songs = playlist_info.total;
        const iterations = Math.ceil(total_songs/100);

        let promises = []; //holds the amount of api calls we need to execute to gather all songs from a playlist
        for (let i = 0; i < iterations; i++){
            promises.push(getRestOfSongs(accessToken, i*100));
        }

        const playlist_objs = await Promise.all(promises);
        for(let k = 0; k < playlist_objs.length; k++) {
            let iteration_size = playlist_objs[k].items.length; //holds the number of songs for the k iteration (1-100)
            for(let p = 0; p < iteration_size; p++){
                let artist_names = "";
                let artist_size = playlist_objs[k].items[p].track.artists.length;
                for(let m = 0; m < artist_size; m++){
                    artist_names += playlist_objs[k].items[p].track.artists[m].name + ", ";
                }
                array_songs.push(playlist_objs[k].items[p].track.name + "--" + artist_names);
            }
        }
        let game_active = true; //game active flag
        await resetScore(interaction.guildId); //resets scores in db
        //make sure playlist has more than 5 songs
        if(array_songs.length < 5) {
            if(array_songs.length === 0){
                interaction.channel.send('Ending... No songs found. Please ensure the playlist is public and the link is valid.')
            } else {
                interaction.channel.send('Ending... Please choose a playlist with more than 5 songs');
            }
            return;
        }
        const shuffled_songs_array = shuffleSongs(array_songs);

        const player = useMainPlayer();
        const voice_channel = interaction.member.voice.channel;
        
        const playlist_size = shuffled_songs_array.length;
        let current_index = 0; //index of song
        
        
        const queue = await player.nodes.create(interaction.guildId); //create a queue for this server
        //if vc isnt connected, connect to the vc that the interaction is in
        if(!queue.connection) {
            await queue.connect(interaction.member.voice.channel);
        }
        //console.log(queue);
        while(game_active){
            //check if were at max index
            if(current_index === playlist_size){
                interaction.channel.send('No more songs left to play...Ending game!');
                queue.delete();
                //show score embed here
                break;
            }
            let query = shuffled_songs_array[current_index] + "audio";
            let song_info = ""; //holds the track info returned from the player
            let song_title = query.split('--')[0]; //sets song answer to just the title without the artists
            let song_title_filtered = song_title.split('(')[0]; //removes the (feat. ) from titles if exists
            console.log(song_title_filtered);

            try {
             
                const result = await player.search(query, {
                    requestedBy: interaction.user,
                    searchEngine: QueryType.YOUTUBE_SEARCH
                })

                if(result.tracks.length === 0){
                    return interaction.channel.send('Cannot find track');
                }

                const song = result.tracks[0];
                await queue.addTrack(song);
                await queue.node.play();
                
                song_info = query.replace("--", " by ").replace(", audio", "");
                interaction.channel.send("Playing song...");
            } catch (e) {

                return interaction.followUp(`Something went wrong: ${e}`);
            }
            
            const fil = msg => {
                return msg.content.toUpperCase().trim() === song_title_filtered.toUpperCase().trim() || msg.content === ".q skip";
            }
            let answered_flag = false;
            let collected_answer = await interaction.channel.awaitMessages ({ filter : fil, max : 1, time : 5000 }).catch((err) => {
                console.log(err);
            });
  
            if(collected_answer.size === 0) {
                interaction.channel.send("No one answered correctly within 45 seconds. The song was : " + song_info);
            } else {
                let msg_info = collected_answer.first();
                if(msg_info.content === ".q skip"){
                    msg_info.reply("Skipping song...");
                    queue.node.setPaused(!queue.node.isPaused()); //pauses the queue
                } else {
                    await givePoint(msg_info, client);
                    queue.node.setPaused(!queue.node.isPaused()); //pauses the queue
                    collected_answer.first().reply('Correct! The song was : ' + song_info);
                }
            }

        
            let top_player = await getTopPlayer();
            if (top_player.score >= 3){
                game_active = false;
                queue.delete();
                //temp congrats statement
                interaction.channel.send(`<@${top_player.userId}> Congrats you win with 3 points!`);
            } 
            current_index += 1;
            await new Promise(resolve => {setTimeout(resolve, 3000)}); //created a timer so that its not rapid fire song after song
        }
        
    },
};